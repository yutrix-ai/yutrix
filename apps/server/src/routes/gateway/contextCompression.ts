/**
 * In-place context compression.
 *
 * When a strategy layer's overflow action is "compress" and the estimated input
 * reaches 80% of that model's configured window, older turns are summarized and
 * the request stays on the same model. The summary follows the same cut the
 * major agent stacks use (Claude compaction, session-memory cookbook):
 * system prompt stays, the last two turns stay word for word (images included),
 * a tool call and its result are never split, and the summary keeps goals,
 * corrections, identifiers, and errors instead of a vague paraphrase.
 * Older images are not sent to the text compressor. The newest of them, as many
 * as the layer's vision model can hold, are described by that vision model and
 * the description is folded into the summary.
 */
import { db } from "../../db";
import { providerApiKeys, providerModels, providers } from "../../db/schema";
import { and, eq } from "drizzle-orm";
import { decryptText } from "../../utils/crypto";
import { cloneJsonSharingStrings } from "../../utils/shareClone";
import { getStrategyRuleForLayer } from "../../services/strategyRouting";
import { findLongContextTarget } from "./longContextChain";
import { estimateMultimodalInputUsage, ROUTING_IMAGE_TOKEN_BUDGET } from "./inputTokenLimit";
import { fitsContextBudget, resolveModelContextWindow } from "./gatewayExecutorUtils";

export const COMPRESS_FILL_RATIO = 0.8;
export const KEPT_TAIL_TURNS = 2;
export const SUMMARY_MARKER = "[yutrix-context-summary]";
/** Most recent older images sent to the layer's vision model. The rest are noted as omitted. */
export const MAX_OLDER_IMAGE_CAPTIONS = 4;
const SUMMARY_MAX_TOKENS = 1500;
const CAPTION_MAX_TOKENS = 800;
const CAPTION_PROMPT_TOKENS = 400;
const COMPRESSOR_TIMEOUT_MS = 45_000;

export type OverflowAction = "long_context" | "compress";

export function readLayerOverflowAction(route: any, layerIndex: number): OverflowAction {
  let targets: any[] = [];
  try {
    const parsed = typeof route?.targets === "string" ? JSON.parse(route.targets) : route?.targets;
    targets = Array.isArray(parsed) ? parsed : [];
  } catch {
    targets = [];
  }
  const raw = targets[layerIndex]?.overflowAction;
  return raw === "compress" ? "compress" : "long_context";
}

export function reachesCompressFill(estimatedTokens: number, contextLimit: number): boolean {
  return contextLimit > 0 && estimatedTokens >= Math.floor(contextLimit * COMPRESS_FILL_RATIO);
}

type ChatMessage = { role?: string; content?: any; tool_calls?: any[] };

function isSystemLike(message: ChatMessage): boolean {
  return message?.role === "system" || message?.role === "developer";
}

function hasToolResult(value: any): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(hasToolResult);
  if (typeof value !== "object") return false;
  if (value.type === "tool_result") return true;
  return hasToolResult(value.content);
}

function isNaturalUserMessage(message: ChatMessage): boolean {
  return message?.role === "user" && !hasToolResult(message.content);
}

function splitTurns(messages: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const message of messages) {
    if (isNaturalUserMessage(message) && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

export type CompressionPlan = {
  systemMessages: ChatMessage[];
  older: ChatMessage[];
  kept: ChatMessage[];
  olderTurns: number;
};

/** null when there is no older turn to summarize (the tail is the whole conversation). */
export function planContextCompression(body: any): CompressionPlan | null {
  const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.length === 0) return null;
  const systemMessages = messages.filter(isSystemLike);
  const conversation = messages.filter((message) => !isSystemLike(message));
  const turns = splitTurns(conversation);
  if (turns.length <= KEPT_TAIL_TURNS) return null;
  const olderTurns = turns.slice(0, turns.length - KEPT_TAIL_TURNS);
  const keptTurns = turns.slice(turns.length - KEPT_TAIL_TURNS);
  return {
    systemMessages,
    older: olderTurns.flat(),
    kept: keptTurns.flat(),
    olderTurns: olderTurns.length,
  };
}

function isImagePart(value: any): boolean {
  if (!value || typeof value !== "object") return false;
  return (
    value.type === "image"
    || value.type === "image_url"
    || value.image_url !== undefined
    || value.source?.type === "base64"
  );
}

export type OlderImage = { index: number; part: any };

/** Images in walk order. Index 1 is the oldest image in the summarized turns. */
export function listImageParts(messages: ChatMessage[]): OlderImage[] {
  const found: OlderImage[] = [];
  const walk = (value: any) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value !== "object") return;
    if (isImagePart(value)) {
      found.push({ index: found.length + 1, part: value });
      return;
    }
    if (value.content) walk(value.content);
  };
  for (const message of messages) walk(message.content);
  return found;
}

/**
 * Caption the newest older images that fit the vision model's window.
 * Recent screenshots matter more than ones from the start of the session.
 */
export function selectImagesForCaption(images: OlderImage[], maxCount: number): OlderImage[] {
  if (maxCount <= 0) return [];
  return images.slice(Math.max(0, images.length - maxCount));
}

function textOf(content: any, images: { next: number; captioned: Set<number> }): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (isImagePart(part)) {
        const index = images.next++;
        return images.captioned.has(index) ? `[image ${index} described below]` : "[image omitted]";
      }
      if (typeof part?.text === "string") return part.text;
      if (part?.type === "tool_use" || part?.type === "tool_result") {
        const name = part.name || part.tool_use_id || "tool";
        return `[${part.type} ${name}]`;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") {
    if (isImagePart(content)) {
      const index = images.next++;
      return images.captioned.has(index) ? `[image ${index} described below]` : "[image omitted]";
    }
    if (typeof content.text === "string") return content.text;
  }
  return "";
}

const SUMMARY_INSTRUCTIONS = [
  "You are compacting the earlier part of a conversation so the same task can continue without those messages.",
  "Summarize only what is in the transcript. Do not invent details.",
  "Write in the same language as the conversation.",
  "Use these sections, and omit a section when it has nothing to say:",
  "## Goal",
  "The user's original request, close to their wording.",
  "## Constraints and corrections",
  "Requirements and any correction the user made. Quote corrections verbatim.",
  "## Decisions",
  "Technical choices already made.",
  "## Identifiers",
  "File paths, symbols, APIs, commands, IDs, and config values, copied exactly.",
  "## Errors",
  "Failures and how they were resolved. Quote error text.",
  "## Done",
  "Work already finished.",
  "## Active",
  "What was in progress at the end of this transcript, and the immediate next step.",
  "## Pending",
  "Tasks not finished.",
  "Drop greetings and filler. Prefer exact names over paraphrase. Keep it under 800 words.",
].join("\n");

export function buildCompressorTranscript(
  older: ChatMessage[],
  imageNote?: { captioned: Set<number>; text: string },
): string {
  const images = { next: 1, captioned: imageNote?.captioned ?? new Set<number>() };
  const lines = older.map((message) => {
    const tools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? ` tool_calls=${message.tool_calls.map((call) => call?.function?.name || call?.name || "tool").join(",")}`
      : "";
    return `${message.role || "unknown"}${tools}: ${textOf(message.content, images)}`;
  });
  const note = imageNote?.text?.trim()
    ? `\n\n## Earlier images\nA vision model described the most recent images from the turns above. Quote any errors and paths it reported.\n${imageNote.text.trim()}`
    : "";
  return `${SUMMARY_INSTRUCTIONS}\n\nTranscript:\n${lines.join("\n\n")}${note}`;
}

const CAPTION_INSTRUCTIONS = [
  "Describe each attached image so a later text-only turn can continue the task.",
  "The images are in order, starting at the number you are given.",
  "For each image write:",
  "[image N]",
  "What is visible (editor, terminal, browser, diagram, or UI).",
  "Quote visible errors, file paths, and labels exactly. Do not invent.",
].join("\n");

function imageUrlFromPart(part: any): string | null {
  const url = part?.image_url?.url || part?.url;
  if (typeof url === "string" && url) return url;
  if (part?.source?.type === "base64" && typeof part.source.data === "string" && part.source.data) {
    const media = part.source.media_type || "image/png";
    return `data:${media};base64,${part.source.data}`;
  }
  return null;
}

/** Normalize one stored image part into the vision provider's content format. */
export function toCaptionPart(part: any, anthropic: boolean): any | null {
  const url = imageUrlFromPart(part);
  if (!url) return null;
  if (!anthropic) return { type: "image_url", image_url: { url } };
  const dataUrl = /^data:([^;]+);base64,([\s\S]+)$/.exec(url);
  if (dataUrl) {
    return { type: "image", source: { type: "base64", media_type: dataUrl[1], data: dataUrl[2] } };
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return { type: "image", source: { type: "url", url } };
  }
  return null;
}

export function applyContextSummary(body: any, summary: string, plan: CompressionPlan): any {
  const next = cloneJsonSharingStrings(body);
  const summaryMessage = { role: "user", content: `${SUMMARY_MARKER}\n${summary.trim()}` };
  const ack = { role: "assistant", content: "Understood. Continuing from the summary and the recent turns that follow." };
  next.messages = [...plan.systemMessages, summaryMessage, ack, ...plan.kept];
  return next;
}

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function readSummaryText(data: any): string {
  const openai = data?.choices?.[0]?.message?.content;
  if (typeof openai === "string" && openai.trim()) return stripThink(openai);
  if (Array.isArray(openai)) {
    const joined = openai.map((part) => (typeof part?.text === "string" ? part.text : "")).join("").trim();
    if (joined) return stripThink(joined);
  }
  if (Array.isArray(data?.content)) {
    const joined = data.content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("").trim();
    if (joined) return stripThink(joined);
  }
  return "";
}

async function callModel(options: {
  baseUrl: string;
  anthropic: boolean;
  apiKey: string;
  modelId: string;
  content: string | any[];
  maxTokens: number;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMPRESSOR_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url: string;
    let payload: any;
    const content = options.anthropic && typeof options.content === "string"
      ? [{ type: "text", text: options.content }]
      : options.content;
    if (options.anthropic) {
      headers["x-api-key"] = options.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      url = `${options.baseUrl}/v1/messages`;
      payload = {
        model: options.modelId,
        max_tokens: options.maxTokens,
        messages: [{ role: "user", content }],
      };
    } else {
      headers.Authorization = `Bearer ${options.apiKey}`;
      url = `${options.baseUrl}/chat/completions`;
      payload = {
        model: options.modelId,
        max_tokens: options.maxTokens,
        temperature: 0,
        stream: false,
        messages: [{ role: "user", content }],
      };
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) return "";
    const data = await response.json();
    return readSummaryText(data);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

type UpstreamCall = { baseUrl: string; anthropic: boolean; apiKey: string; modelId: string };

async function loadUpstream(providerId: string, modelId: string, protocol: string): Promise<UpstreamCall | null> {
  const providerRows = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
  const provider = providerRows[0];
  if (!provider) return null;
  const anthropic = protocol === "anthropic";
  const rawBase = anthropic ? provider.anthropicBaseUrl : (provider.openaiBaseUrl || provider.anthropicBaseUrl);
  const baseUrl = (rawBase || "").replace(/\/+$/, "");
  if (!baseUrl) return null;
  const keys = await db
    .select()
    .from(providerApiKeys)
    .where(and(eq(providerApiKeys.providerId, providerId), eq(providerApiKeys.status, "active")))
    .limit(1);
  if (keys.length === 0) return null;
  const apiKey = decryptText(keys[0].keyEncrypted);
  if (!apiKey) return null;
  return { baseUrl, anthropic, apiKey, modelId };
}

function findLayerVisionTarget(route: any, layerIndex: number): { providerId: string; modelId: string; protocol: string } | null {
  let targets: any[] = [];
  try {
    const parsed = typeof route?.targets === "string" ? JSON.parse(route.targets) : route?.targets;
    targets = Array.isArray(parsed) ? parsed : [];
  } catch {
    targets = [];
  }
  const layerCount = Math.max(targets.length, 1);
  for (let i = Math.max(0, layerIndex); i < layerCount; i++) {
    const rule = getStrategyRuleForLayer(route, i, "vision");
    if (!rule?.providerId || !rule?.modelId) continue;
    return {
      providerId: rule.providerId,
      modelId: rule.modelId,
      protocol: rule.providerProtocol || "openai",
    };
  }
  return null;
}

async function captionSlotCount(providerId: string, modelId: string): Promise<number> {
  const rows = await db
    .select()
    .from(providerModels)
    .where(and(eq(providerModels.providerId, providerId), eq(providerModels.modelId, modelId)))
    .limit(1);
  const budget = resolveModelContextWindow(rows[0] ?? null);
  if (budget.limit <= 0) return MAX_OLDER_IMAGE_CAPTIONS;
  const room = budget.limit - CAPTION_PROMPT_TOKENS - CAPTION_MAX_TOKENS - 50;
  return Math.max(0, Math.min(MAX_OLDER_IMAGE_CAPTIONS, Math.floor(room / ROUTING_IMAGE_TOKEN_BUDGET)));
}

async function describeOlderImages(options: {
  route: any;
  layerIndex: number;
  older: ChatMessage[];
}): Promise<{ captioned: Set<number>; text: string } | undefined> {
  const images = listImageParts(options.older);
  if (images.length === 0) return undefined;
  const vision = findLayerVisionTarget(options.route, options.layerIndex);
  if (!vision) return undefined;
  const slots = await captionSlotCount(vision.providerId, vision.modelId);
  const chosen = selectImagesForCaption(images, Math.min(slots, MAX_OLDER_IMAGE_CAPTIONS));
  if (chosen.length === 0) return undefined;
  const upstream = await loadUpstream(vision.providerId, vision.modelId, vision.protocol);
  if (!upstream) return undefined;
  const parts = chosen
    .map((image) => toCaptionPart(image.part, upstream.anthropic))
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  const first = chosen[0].index;
  const prompt = `${CAPTION_INSTRUCTIONS}\nThe first attached image is image ${first}.`;
  const content = upstream.anthropic
    ? [{ type: "text", text: prompt }, ...parts]
    : [{ type: "text", text: prompt }, ...parts];
  const text = await callModel({ ...upstream, content, maxTokens: CAPTION_MAX_TOKENS });
  if (!text) return undefined;
  return { captioned: new Set(chosen.map((image) => image.index)), text };
}

export type CompressResult =
  | { ok: true; body: any; olderTurns: number; compressorModelId: string }
  | { ok: false; reason: "nothing_to_summarize" | "no_compressor" | "empty_summary" | "compressor_failed" };

export async function compressGatewayContext(options: {
  route: any;
  body: any;
  incomingProtocol: string;
  layerIndex: number;
  currentProviderId: string;
  currentModelId: string;
  currentProtocol: string;
  currentContextLimit: number;
}): Promise<CompressResult> {
  const plan = planContextCompression(options.body);
  if (!plan) return { ok: false, reason: "nothing_to_summarize" };

  const imageNote = await describeOlderImages({
    route: options.route,
    layerIndex: options.layerIndex,
    older: plan.older,
  });
  const transcript = buildCompressorTranscript(plan.older, imageNote);
  const compressorBody = { messages: [{ role: "user", content: transcript }] };
  const usage = await estimateMultimodalInputUsage({ body: compressorBody });

  const longTarget = await findLongContextTarget({
    route: options.route,
    startIndex: options.layerIndex,
    incomingProtocol: options.incomingProtocol,
    estimatedTokens: usage.totalTokens,
    exclude: new Set(),
  });

  let providerId = longTarget?.providerId || "";
  let modelId = longTarget?.modelId || "";
  let protocol = longTarget?.providerProtocol || "openai";
  if (!longTarget) {
    const currentFits = options.currentContextLimit <= 0 || fitsContextBudget({
      inputTokens: usage.totalTokens,
      requestedOutputTokens: SUMMARY_MAX_TOKENS,
      safetyMargin: 50,
      budget: { limit: options.currentContextLimit, kind: "total_context", source: "contextWindowTokens" },
    });
    if (!currentFits || !options.currentProviderId || !options.currentModelId) {
      return { ok: false, reason: "no_compressor" };
    }
    providerId = options.currentProviderId;
    modelId = options.currentModelId;
    protocol = options.currentProtocol || "openai";
  }

  const upstream = await loadUpstream(providerId, modelId, protocol);
  if (!upstream) return { ok: false, reason: "no_compressor" };

  const summary = await callModel({ ...upstream, content: transcript, maxTokens: SUMMARY_MAX_TOKENS });
  if (!summary) return { ok: false, reason: "empty_summary" };
  return {
    ok: true,
    body: applyContextSummary(options.body, summary, plan),
    olderTurns: plan.olderTurns,
    compressorModelId: modelId,
  };
}
