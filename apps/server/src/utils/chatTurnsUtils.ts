import crypto from "crypto";

export const DATA_PREVIEW_LENGTH = 32;

export const TITLE_GENERATION_MARKERS = [
  "succinct title for a coding session",
  "generate a title for this conversation",
  "generate a title",
  "generate a concise title",
  "conversation title",
  "chat title",
  "会话标题",
  "生成标题",
  "概括标题",
];

export const EMBEDDED_PROMPT_KEYS = new Set([
  "prompt",
  "prompts",
  "instruction",
  "instructions",
  "query",
  "question",
  "message",
  "messages",
  "content",
  "text",
  "task",
]);

export function computeContentHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").substring(0, 24);
}

export function tryParseJson(text: string | null | undefined): any | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function looksLikeContentBlock(value: any): boolean {
  return isRecord(value) && typeof value.type === "string" && !("role" in value);
}

export function looksLikeChatMessage(value: any): boolean {
  return isRecord(value) && ("role" in value || "content" in value || "tool_calls" in value);
}

export function looksLikeTitleGenerationText(text: string): boolean {
  const normalized = text.toLowerCase();
  return TITLE_GENERATION_MARKERS.some((marker) => normalized.includes(marker));
}

export function stripReasoningMarkers(text: string): string {
  return text
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, "")
    .trim();
}

export function compactWhitespace(text: string): string {
  return text.trim().replace(/\r\n/g, "\n");
}

export function normalizeLargeString(value: string): string {
  if (value.startsWith("data:image/")) {
    return `[data-image:${computeContentHash(value)}:${value.length}]`;
  }

  if (
    value.length > 512 &&
    (value.startsWith("iVBORw0K") ||
      value.startsWith("/9j/") ||
      value.startsWith("UklGR") ||
      value.startsWith("JVBERi"))
  ) {
    return `[binary:${computeContentHash(value)}:${value.length}:${value.substring(0, DATA_PREVIEW_LENGTH)}]`;
  }

  return compactWhitespace(value);
}

export function normalizeValueForFingerprint(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return normalizeLargeString(value);
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map(normalizeValueForFingerprint);
  }

  const normalized: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    const nested = value[key];
    if (key === "id" && typeof nested === "string" && /^call_|^toolu_|^[a-zA-Z0-9_-]{12,}$/.test(nested)) {
      continue;
    }
    normalized[key] = normalizeValueForFingerprint(nested);
  }
  return normalized;
}

export function stableStringify(value: any): string {
  return JSON.stringify(normalizeValueForFingerprint(value));
}

export function simplifyMessageForStorage(message: any): Record<string, any> {
  const compact: Record<string, any> = {};
  if (message.role) compact.role = message.role;
  if (message.name) compact.name = message.name;
  if (message.content !== undefined) compact.content = message.content;
  if (message.tool_call_id) compact.tool_call_id = message.tool_call_id;
  if (message.tool_calls) compact.tool_calls = message.tool_calls;
  return compact;
}

export function serializeContentForLog(content: any): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

export function serializeMessagesForLog(messages: any[]): string | null {
  if (messages.length === 0) return null;

  if (messages.length === 1) {
    const only = messages[0];
    if (only.role === "user" || only.role === "system") {
      const contentText = serializeContentForLog(only.content);
      if (contentText !== null) return contentText;
    }
  }

  return JSON.stringify(messages.map(simplifyMessageForStorage));
}

export function parseToolCallArguments(value: any): any | null {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
