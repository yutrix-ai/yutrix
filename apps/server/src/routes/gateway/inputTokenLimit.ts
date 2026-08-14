import { exactEstimateTokens, estimateTokensFallback } from "../../utils/tokenizer";
import { isImageNode } from "../../utils/multimodal";

type ChatMessage = Record<string, any> & {
  role?: string;
  content?: any;
  tool_calls?: any[];
  tool_call_id?: string;
};

export interface InputTokenLimitConfig {
  maxInputTokens: number;
  modelId: string;
  providerProtocol: string;
  tokenizerRepo?: string | null;
  proxyUrl?: string | null;
}

export interface InputTokenTruncationResult {
  body: any;
  truncated: boolean;
  originalTokens: number;
  finalTokens: number;
  maxInputTokens: number;
  budgetTokens: number;
  droppedTurns: number;
  textTruncated: boolean;
}

export class InputTokenLimitError extends Error {
  statusCode = 400;
  code = "input_token_limit_exceeded";

  constructor(message: string) {
    super(message);
  }
}

const REPLY_PRIMING_TOKENS = 2;
const MESSAGE_FRAME_TOKENS = 4;
const TOOL_CALL_PADDING_TOKENS = 12;
const TRUNCATION_MARKER = "\n\n[PromptGate: content truncated to fit input token limit]\n\n";

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function isSystemLikeMessage(message: ChatMessage): boolean {
  return message.role === "system" || message.role === "developer";
}

function hasToolResultContent(value: any): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(hasToolResultContent);
  if (typeof value !== "object") return false;
  if (value.type === "tool_result") return true;
  return hasToolResultContent(value.content);
}

function isNaturalUserMessage(message: ChatMessage): boolean {
  return message.role === "user" && !hasToolResultContent(message.content);
}

function isImageLikeContent(value: any): boolean {
  if (!value || typeof value !== "object") return false;
  return (
    value.type === "image" ||
    value.type === "image_url" ||
    value.image_url !== undefined ||
    value.source?.type === "base64"
  );
}



function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function splitConversationTurns(messages: ChatMessage[]): ChatMessage[][] {
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

function segmentText(text: string): string[] {
  const Segmenter = (Intl as any).Segmenter;
  if (Segmenter) {
    const segmenter = new Segmenter("zh-CN", { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (segment: any) => segment.segment);
  }
  return Array.from(text);
}

function makeHeadTailText(text: string, keepSegments: number): string {
  const segments = segmentText(text);
  if (keepSegments >= segments.length) return text;
  if (keepSegments <= 0) return TRUNCATION_MARKER.trim();

  const headCount = Math.ceil(keepSegments * 0.65);
  const tailCount = Math.max(0, keepSegments - headCount);
  const head = segments.slice(0, headCount).join("");
  const tail = tailCount > 0 ? segments.slice(segments.length - tailCount).join("") : "";
  return `${head}${TRUNCATION_MARKER}${tail}`;
}

interface TextTarget {
  length: number;
  set(value: string): void;
}

function collectTextTargets(value: any): TextTarget[] {
  const targets: TextTarget[] = [];
  const visit = (node: any, setter?: (value: string) => void) => {
    if (typeof node === "string") {
      if (setter) targets.push({ length: segmentText(node).length, set: setter });
      return;
    }
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, (value) => {
        node[index] = value;
      }));
      return;
    }

    if (typeof node.text === "string") {
      targets.push({
        length: segmentText(node.text).length,
        set: (value) => { node.text = value; },
      });
    }
    if (typeof node.input_text === "string") {
      targets.push({
        length: segmentText(node.input_text).length,
        set: (value) => { node.input_text = value; },
      });
    }
    if (typeof node.content === "string") {
      targets.push({
        length: segmentText(node.content).length,
        set: (value) => { node.content = value; },
      });
    } else if (Array.isArray(node.content)) {
      visit(node.content);
    }
  };

  visit(value);
  return targets;
}

function collectMessageTextTargets(message: ChatMessage): TextTarget[] {
  if (typeof message.content === "string") {
    return [{
      length: segmentText(message.content).length,
      set: (value) => { message.content = value; },
    }];
  }
  return collectTextTargets(message.content);
}

function collectBodyTextTargets(body: any): TextTarget[] {
  const targets: TextTarget[] = [];
  for (const key of ["prompt", "input", "instructions", "system"]) {
    if (typeof body?.[key] === "string") {
      targets.push({
        length: segmentText(body[key]).length,
        set: (value) => { body[key] = value; },
      });
    } else if (body?.[key] !== undefined) {
      targets.push(...collectTextTargets(body[key]));
    }
  }
  return targets;
}

function findBestTextTarget(turn: ChatMessage[]): { message: ChatMessage; target: TextTarget } | null {
  const naturalUsers = turn.filter(isNaturalUserMessage).reverse();
  for (const message of naturalUsers) {
    const targets = collectMessageTextTargets(message).sort((a, b) => b.length - a.length);
    if (targets.length > 0) return { message, target: targets[0] };
  }

  for (const message of [...turn].reverse()) {
    const targets = collectMessageTextTargets(message).sort((a, b) => b.length - a.length);
    if (targets.length > 0) return { message, target: targets[0] };
  }
  return null;
}

function collectRawTextTargets(value: any): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectRawTextTargets);

  const texts: string[] = [];
  if (typeof value.text === "string") texts.push(value.text);
  if (typeof value.input_text === "string") texts.push(value.input_text);
  if (typeof value.content === "string") texts.push(value.content);
  if (Array.isArray(value.content)) texts.push(...value.content.flatMap(collectRawTextTargets));
  return texts;
}

function collectBodyRawTextTargets(body: any): string[] {
  const texts: string[] = [];
  for (const key of ["prompt", "input", "instructions", "system"]) {
    if (typeof body?.[key] === "string") {
      texts.push(body[key]);
    } else if (body?.[key] !== undefined) {
      texts.push(...collectRawTextTargets(body[key]));
    }
  }
  return texts;
}

function computeBudget(maxInputTokens: number, providerProtocol: string, body: any): number {
  const hasComplexInputs = Boolean(
    body?.tools ||
    body?.functions ||
    safeJson(body).includes('"image') ||
    safeJson(body).includes('"tool_use"') ||
    safeJson(body).includes('"tool_result"'),
  );
  const ratio = providerProtocol === "anthropic"
    ? (hasComplexInputs ? 0.2 : 0.15)
    : (hasComplexInputs ? 0.1 : 0.06);
  return Math.max(1, Math.floor(maxInputTokens * (1 - ratio)));
}

function getTargetText(message: ChatMessage, target: TextTarget): string {
  const candidates = collectRawTextTargets(message.content);
  const match = candidates.find((candidate) => segmentText(candidate).length === target.length);
  return match || candidates.sort((a, b) => b.length - a.length)[0] || "";
}

/** Clone-and-measure so overflow hop can decide before mutating the outbound body. */
export async function previewInputTokenLimit(
  inputBody: any,
  config: InputTokenLimitConfig,
): Promise<InputTokenTruncationResult> {
  const clone = cloneJson(inputBody);
  return applyInputTokenLimit(clone, config);
}

export async function applyInputTokenLimit(
  inputBody: any,
  config: InputTokenLimitConfig,
): Promise<InputTokenTruncationResult> {
  const maxInputTokens = Math.max(0, Math.floor(config.maxInputTokens || 0));
  const body = inputBody;
  
  const tokenEst = await estimateMultimodalInputUsage({ body, modelId: config.modelId, tokenizerRepo: config.tokenizerRepo, weightProxyUrl: config.proxyUrl });
  const originalTokens = tokenEst.totalTokens;

  if (maxInputTokens <= 0 || originalTokens <= maxInputTokens) {
    return {
      body,
      truncated: false,
      originalTokens,
      finalTokens: originalTokens,
      maxInputTokens,
      budgetTokens: maxInputTokens,
      droppedTurns: 0,
      textTruncated: false,
    };
  }

  const budgetTokens = computeBudget(maxInputTokens, config.providerProtocol, body);

  if (!Array.isArray(body.messages)) {
    const textBody = cloneJson(body);
    const targets = collectBodyTextTargets(textBody).sort((a, b) => b.length - a.length);
    if (targets.length === 0) {
      throw new InputTokenLimitError("请求输入超过 token 限制，且没有可截断的文本内容。");
    }

    const originalText = collectBodyRawTextTargets(body).sort((a, b) => b.length - a.length)[0] || "";
    let low = 0;
    let high = segmentText(originalText).length;
    let best: any = null;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = cloneJson(textBody);
      const candidateTargets = collectBodyTextTargets(candidate).sort((a, b) => b.length - a.length);
      candidateTargets[0].set(makeHeadTailText(originalText, mid));
      
      const candidateTokensEst = await estimateMultimodalInputUsage({ body: candidate, modelId: config.modelId, tokenizerRepo: config.tokenizerRepo, weightProxyUrl: config.proxyUrl });
      
      if (candidateTokensEst.totalTokens <= budgetTokens) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (!best) throw new InputTokenLimitError("请求输入超过 token 限制，且无法在保留必要结构后满足限制。");
    Object.keys(body).forEach((key) => delete body[key]);
    Object.assign(body, best);
    
    const finalTokensEst = await estimateMultimodalInputUsage({ body, modelId: config.modelId, tokenizerRepo: config.tokenizerRepo, weightProxyUrl: config.proxyUrl });
    
    return {
      body,
      truncated: true,
      originalTokens,
      finalTokens: finalTokensEst.totalTokens,
      maxInputTokens,
      budgetTokens,
      droppedTurns: 0,
      textTruncated: true,
    };
  }

  const systemMessages = body.messages.filter(isSystemLikeMessage);
  const conversationMessages = body.messages.filter((message: ChatMessage) => !isSystemLikeMessage(message));
  const turns = splitConversationTurns(conversationMessages);
  
  const fixedBody = cloneJson(body);
  fixedBody.messages = systemMessages;
  const fixedTokensEst = await estimateMultimodalInputUsage({ body: fixedBody, modelId: config.modelId, tokenizerRepo: config.tokenizerRepo, weightProxyUrl: config.proxyUrl });

  if (fixedTokensEst.totalTokens >= budgetTokens) {
    throw new InputTokenLimitError("系统提示词、工具定义或固定请求参数已经超过输入 token 限制。");
  }

  const availableForTurns = budgetTokens - fixedTokensEst.totalTokens;
  let usedTurnTokens = 0;
  let droppedTurns = 0;
  let textTruncated = false;
  const survivingTurns: ChatMessage[][] = [];

  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    
    const turnTokensEst = await estimateMultimodalInputUsage({ 
      body: { messages: turn }, 
      modelId: config.modelId, 
      tokenizerRepo: config.tokenizerRepo, 
      weightProxyUrl: config.proxyUrl 
    });
    const turnTokens = turnTokensEst.totalTokens;
    
    if (usedTurnTokens + turnTokens <= availableForTurns) {
      survivingTurns.unshift(turn);
      usedTurnTokens += turnTokens;
      continue;
    }

    if (index === turns.length - 1 && survivingTurns.length === 0) {
      // Need to truncate this single turn
      const working = cloneJson(turn);
      const targetInfo = findBestTextTarget(working);
      if (!targetInfo) {
        throw new InputTokenLimitError("最新用户请求超过输入 token 限制，且没有可安全截断的文本内容。");
      }

      const originalTargetLength = targetInfo.target.length;
      let low = 0;
      let high = originalTargetLength;
      let bestTurn: ChatMessage[] | null = null;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidateTurn = cloneJson(working);
        const candidateTarget = findBestTextTarget(candidateTurn);
        if (!candidateTarget) break;

        const originalTextTarget = findBestTextTarget(turn);
        if (!originalTextTarget) break;
        const originalText = getTargetText(originalTextTarget.message, originalTextTarget.target);
        candidateTarget.target.set(makeHeadTailText(originalText, mid));

        const candidateBody = cloneJson(body);
        candidateBody.messages = [...systemMessages, ...candidateTurn];
        const candidateTokensEst = await estimateMultimodalInputUsage({ body: candidateBody, modelId: config.modelId, tokenizerRepo: config.tokenizerRepo, weightProxyUrl: config.proxyUrl });
        
        if (candidateTokensEst.totalTokens <= budgetTokens) {
          bestTurn = candidateTurn;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      
      if (!bestTurn) {
        throw new InputTokenLimitError("最新用户请求超过输入 token 限制，且没有可安全截断的文本内容。");
      }
      survivingTurns.unshift(bestTurn);
      textTruncated = true;
      droppedTurns = index;
    } else {
      droppedTurns = index + 1;
    }
    break;
  }

  body.messages = [...systemMessages, ...survivingTurns.flat()];
  const finalTokensEst = await estimateMultimodalInputUsage({ body, modelId: config.modelId, tokenizerRepo: config.tokenizerRepo, weightProxyUrl: config.proxyUrl });

  return {
    body,
    truncated: true,
    originalTokens,
    finalTokens: finalTokensEst.totalTokens,
    maxInputTokens,
    budgetTokens,
    droppedTurns,
    textTruncated,
  };
}

export const ROUTING_IMAGE_TOKEN_BUDGET = 4096;

export function estimateInputTokensRough(body: any, modelId?: string): number {
  const text = JSON.stringify(body);
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      tokens += 0.33; // ASCII: ~3 chars per token
    } else if (code >= 0x4e00 && code <= 0x9fff) {
      tokens += 1.2;  // CJK: ~1.2 tokens per char
    } else {
      tokens += 0.5;  // Other Unicode
    }
  }
  return Math.ceil(tokens);
}

function cloneAndStripImages(node: any): { cleaned: any; imageCount: number } {
  let imageCount = 0;

  function recurse(val: any): any {
    if (val === null || val === undefined) return val;
    if (isImageNode(val)) {
      imageCount++;
      const cloned: any = { ...val };
      if (cloned.source && typeof cloned.source === "object") {
        cloned.source = { ...cloned.source, data: "", url: "" };
      }
      if (cloned.image_url !== undefined) {
        if (typeof cloned.image_url === "object" && cloned.image_url !== null) {
          cloned.image_url = { ...cloned.image_url, url: "" };
        } else {
          cloned.image_url = "";
        }
      }
      if (cloned.image !== undefined) {
        cloned.image = "";
      }
      if (cloned.data !== undefined) {
        cloned.data = "";
      }
      if (cloned.url !== undefined) {
        cloned.url = "";
      }
      return cloned;
    }
    if (Array.isArray(val)) {
      return val.map(recurse);
    }
    if (typeof val === "object") {
      const copy: any = {};
      for (const key of Object.keys(val)) {
        copy[key] = recurse(val[key]);
      }
      return copy;
    }
    return val;
  }

  const cleaned = recurse(node);
  return { cleaned, imageCount };
}

export function inspectOutboundCapabilities(body: any): {
  vision: boolean;
  imageCount: number;
} {
  const { imageCount } = cloneAndStripImages(body);
  return {
    vision: imageCount > 0,
    imageCount,
  };
}

export async function estimateMultimodalInputUsage(options: {
  body: any;
  modelId?: string;
  tokenizerRepo?: string | null;
  weightProxyUrl?: string | null;
}): Promise<{
  textTokens: number;
  imageTokens: number;
  totalTokens: number;
  imageCount: number;
}> {
  const { cleaned, imageCount } = cloneAndStripImages(options.body);
  
  // Use lightning-fast rough estimation for all input body routing and limiting,
  // as it was implemented originally. This prevents any event loop blocking
  // during high concurrency or with massive prompts.
  const textTokens = estimateInputTokensRough(cleaned, options.modelId);
  
  const imageTokens = imageCount * ROUTING_IMAGE_TOKEN_BUDGET;
  return {
    textTokens,
    imageTokens,
    totalTokens: textTokens + imageTokens,
    imageCount,
  };
}
