/**
 * In-place context compression.
 *
 * When a strategy layer's overflow action is "compress" and the estimated input
 * reaches 80% of that model's configured window, older turns are summarized and
 * the request stays on the same model. The summary follows the same cut the
 * major agent stacks use (Claude compaction, session-memory cookbook):
 * system prompt stays, the last two turns stay word for word, a tool call and
 * its result are never split, and the summary keeps goals, corrections,
 * identifiers, and errors instead of a vague paraphrase.
 */
import { db } from "../../db";
import { providerApiKeys, providers } from "../../db/schema";
import { and, eq } from "drizzle-orm";
import { decryptText } from "../../utils/crypto";
import { findLongContextTarget } from "./longContextChain";
import { estimateMultimodalInputUsage } from "./inputTokenLimit";
import { fitsContextBudget } from "./gatewayExecutorUtils";

export const COMPRESS_FILL_RATIO = 0.8;
export const KEPT_TAIL_TURNS = 2;
export const SUMMARY_MARKER = "[yutrix-context-summary]";
const SUMMARY_MAX_TOKENS = 1500;
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

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (isImagePart(part)) return "[image omitted]";
      if (typeof part?.text === "string") return part.text;
      if (part?.type === "tool_use" || part?.type === "tool_result") {
        const name = part.name || part.tool_use_id || "tool";
        return `[${part.type} ${name}]`;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (isImagePart(content)) return "[image omitted]";
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

export function buildCompressorTranscript(older: ChatMessage[]): string {
  const lines = older.map((message) => {
    const tools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? ` tool_calls=${message.tool_calls.map((call) => call?.function?.name || call?.name || "tool").join(",")}`
      : "";
    return `${message.role || "unknown"}${tools}: ${textOf(message.content)}`;
  });
  return `${SUMMARY_INSTRUCTIONS}\n\nTranscript:\n${lines.join("\n\n")}`;
}

export function applyContextSummary(body: any, summary: string, plan: CompressionPlan): any {
  const next = JSON.parse(JSON.stringify(body));
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

async function callCompressor(options: {
  baseUrl: string;
  anthropic: boolean;
  apiKey: string;
  modelId: string;
  transcript: string;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMPRESSOR_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url: string;
    let payload: any;
    if (options.anthropic) {
      headers["x-api-key"] = options.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      url = `${options.baseUrl}/v1/messages`;
      payload = {
        model: options.modelId,
        max_tokens: SUMMARY_MAX_TOKENS,
        messages: [{ role: "user", content: options.transcript }],
      };
    } else {
      headers.Authorization = `Bearer ${options.apiKey}`;
      url = `${options.baseUrl}/chat/completions`;
      payload = {
        model: options.modelId,
        max_tokens: SUMMARY_MAX_TOKENS,
        temperature: 0,
        stream: false,
        messages: [{ role: "user", content: options.transcript }],
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

  const transcript = buildCompressorTranscript(plan.older);
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

  const providerRows = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
  const provider = providerRows[0];
  if (!provider) return { ok: false, reason: "no_compressor" };
  const anthropic = protocol === "anthropic";
  const rawBase = anthropic ? provider.anthropicBaseUrl : (provider.openaiBaseUrl || provider.anthropicBaseUrl);
  const baseUrl = (rawBase || "").replace(/\/+$/, "");
  if (!baseUrl) return { ok: false, reason: "no_compressor" };

  const keys = await db
    .select()
    .from(providerApiKeys)
    .where(and(eq(providerApiKeys.providerId, providerId), eq(providerApiKeys.status, "active")))
    .limit(1);
  if (keys.length === 0) return { ok: false, reason: "no_compressor" };
  const apiKey = decryptText(keys[0].keyEncrypted);
  if (!apiKey) return { ok: false, reason: "no_compressor" };

  const summary = await callCompressor({ baseUrl, anthropic, apiKey, modelId, transcript });
  if (!summary) return { ok: false, reason: "empty_summary" };
  return {
    ok: true,
    body: applyContextSummary(options.body, summary, plan),
    olderTurns: plan.olderTurns,
    compressorModelId: modelId,
  };
}
