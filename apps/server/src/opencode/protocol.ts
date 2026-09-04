/**
 * OpenCode Session API helpers (opencode 1.18.x).
 *
 * Proven wire shape:
 *   POST /session            { title }           → { id: "ses_..." }
 *   POST /session/:id/message
 *     { model: { providerID, modelID }, parts: [{ type: "text", text }] }
 *     → { parts: [...] }  (join only type==="text"; skip reasoning)
 *
 * providerID is an OpenCode slug (e.g. "openrouter"), never a yutrix UUID.
 * API clients never see OpenCode; responses are OpenAI/Anthropic shaped.
 */

export function resolveOpencodeProviderSlug(provider: {
  openaiBaseUrl?: string | null;
  anthropicBaseUrl?: string | null;
  protocol?: string | null;
} | null | undefined): string {
  const openai = String(provider?.openaiBaseUrl || "").toLowerCase();
  const anthropic = String(provider?.anthropicBaseUrl || "").toLowerCase();
  if (openai.includes("openrouter")) return "openrouter";
  if (openai.includes("openai.com") || /\/\/api\.openai(?:\.)/.test(openai)) return "openai";
  if (openai.includes("googleapis") || openai.includes("generativelanguage")) return "google";
  if (anthropic.includes("anthropic") || provider?.protocol === "anthropic") return "anthropic";
  return "openrouter";
}

export function shouldRouteViaOpencode(
  modelConfig: { useOpencodeProxy?: boolean | null } | null | undefined,
): boolean {
  return modelConfig?.useOpencodeProxy === true;
}

/** Prepended on every gateway Session turn so the sidecar stays chat-shaped. */
export const OPENCODE_CHAT_ONLY_INSTRUCTION =
  "This turn is plain chat. Answer the user in natural language only. Do not call tools and do not emit tool markup.";

/** Stronger nudge used for a single retry when the first reply is tool markup only. */
export const OPENCODE_CHAT_ONLY_RETRY_NUDGE =
  "Reply in plain text only. Do not call tools and do not emit tool markup.";

const OPENCODE_TOOL_FENCE_RE =
  /<\|(?:message_model|content_invoke_tool_json|end_message|invoke_tool|tool_calls?|start_tool|end_tool)(?:\|[^|\n]{0,80})?\|>/gi;

const OPENCODE_GENERIC_FENCE_RE = /<\|[A-Za-z][\w.]{0,78}\|>/g;

const TOOL_XML_BLOCK_RE =
  /<(tool_calls?|function_calls?|invoke|tool_use|tool_result)\b[^>]*>[\s\S]*?<\/\1>/gi;

const TOOL_XML_TAG_RE =
  /<\/?(?:tool_calls?|function_calls?|invoke|tool_use|tool_result)(?:\s[^>]*)?\/?>/gi;

function looksLikeToolJson(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !/"name"\s*:/.test(trimmed)) return false;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed.name !== "string") return false;
    return (
      parsed.arguments !== undefined ||
      parsed.parameters !== undefined ||
      parsed.input !== undefined ||
      parsed.url !== undefined ||
      parsed.query !== undefined
    );
  } catch {
    return /"name"\s*:\s*"[^"]+"/.test(trimmed) && /\.\.\.|arguments|parameters|input|"url"/.test(trimmed);
  }
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stripToolJsonObjects(text: string): string {
  let i = 0;
  let out = "";
  while (i < text.length) {
    if (text[i] === "{") {
      const end = findMatchingBrace(text, i);
      if (end !== -1) {
        const slice = text.slice(i, end + 1);
        if (looksLikeToolJson(slice)) {
          i = end + 1;
          continue;
        }
      } else if (looksLikeToolJson(text.slice(i))) {
        break;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

function hadToolMarkup(text: string): boolean {
  return (
    /<\|(?:message_model|content_invoke_tool_json|end_message|invoke_tool|tool_calls?)/i.test(text) ||
    /<\/?(?:tool_calls?|function_calls?|invoke|tool_use)\b/i.test(text)
  );
}

/**
 * Strip OpenCode / tool-invoke markup from joined assistant text.
 * Tool-only replies become empty; surrounding prose is kept.
 */
export function sanitizeOpencodeAssistantText(text: string): string {
  if (!text) return "";
  const original = text;
  let out = text;

  // Complete OpenCode envelopes only — do not consume trailing prose when
  // <|end_message|> is missing.
  out = out.replace(/<\|message_model\|>[\s\S]*?<\|end_message\|>/gi, "");
  out = out.replace(
    /<\|message_model\|>\s*[A-Za-z][\w.]{0,63}\s*(?=<\|content_invoke_tool_json\|>)/gi,
    "",
  );
  out = out.replace(/<\|content_invoke_tool_json\|>/gi, "");
  out = out.replace(OPENCODE_TOOL_FENCE_RE, "");
  out = out.replace(OPENCODE_GENERIC_FENCE_RE, "");
  out = out.replace(TOOL_XML_BLOCK_RE, "");
  out = out.replace(TOOL_XML_TAG_RE, "");
  out = stripToolJsonObjects(out);
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  if (hadToolMarkup(original) && /^[A-Za-z][\w.]{0,63}$/.test(out)) {
    return "";
  }
  return out;
}

export function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const rec = part as Record<string, unknown>;
          if (typeof rec.text === "string") return rec.text;
          if (typeof rec.content === "string") return rec.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const rec = content as Record<string, unknown>;
    if (typeof rec.text === "string") return rec.text;
  }
  return "";
}

function prependChatOnlyInstruction(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return OPENCODE_CHAT_ONLY_INSTRUCTION;
  return `${OPENCODE_CHAT_ONLY_INSTRUCTION}\n\n${trimmed}`;
}

export function buildOpencodeUserText(body: any): string {
  if (typeof body?.prompt === "string" && body.prompt.trim()) {
    return prependChatOnlyInstruction(body.prompt);
  }

  const lines: string[] = [];

  if (typeof body?.system === "string" && body.system.trim()) {
    lines.push(`system: ${body.system}`);
  } else if (Array.isArray(body?.system)) {
    const sys = body.system
      .map((block: any) => extractMessageText(block?.text ?? block?.content ?? block))
      .filter(Boolean)
      .join("\n");
    if (sys) lines.push(`system: ${sys}`);
  }

  if (Array.isArray(body?.messages)) {
    for (const msg of body.messages) {
      const role = String(msg?.role || "user");
      const text = extractMessageText(msg?.content);
      if (!text.trim()) continue;
      if (role === "system") lines.push(`system: ${text}`);
      else if (role === "assistant") lines.push(`assistant: ${text}`);
      else if (role === "tool") lines.push(`tool: ${text}`);
      else lines.push(`user: ${text}`);
    }
  }

  return prependChatOnlyInstruction(lines.join("\n\n"));
}

export function extractOpencodeSessionId(payload: any): string | null {
  const id = payload?.id ?? payload?.data?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Join assistant text parts only. Reasoning / thinking / tool parts are skipped. */
export function joinOpencodeTextParts(payload: any): string {
  const parts = payload?.parts ?? payload?.data?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function toOpenAICompletion(modelId: string, sessionId: string, text: string) {
  return {
    id: `chatcmpl-${sessionId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function toAnthropicMessage(modelId: string, sessionId: string, text: string) {
  return {
    id: sessionId.startsWith("msg_") ? sessionId : `msg_${sessionId}`,
    type: "message",
    role: "assistant",
    model: modelId,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

export interface OpencodeErrorMapping {
  status: number;
  data: { error: { message: string; type: string } };
  authFailed: boolean;
  rateLimited: boolean;
}

export function mapOpencodeHttpError(status: number, bodyText: string): OpencodeErrorMapping {
  const text = (bodyText || "").trim();
  const rateLimited =
    status === 429 || /rate.?limit|too many requests|quota/i.test(text);
  const authFailed =
    status === 401 ||
    status === 403 ||
    /unauthorized|invalid api key|authentication|forbidden|expired.*key/i.test(text);

  if (rateLimited) {
    return {
      status: 429,
      data: { error: { message: text || "rate limited", type: "rate_limit_error" } },
      authFailed: false,
      rateLimited: true,
    };
  }
  if (authFailed) {
    return {
      status: 401,
      data: { error: { message: text || "authentication failed", type: "auth_error" } },
      authFailed: true,
      rateLimited: false,
    };
  }
  return {
    status: status >= 400 ? status : 502,
    data: { error: { message: text || "OpenCode sidecar error", type: "upstream_error" } },
    authFailed: false,
    rateLimited: false,
  };
}

const FORBIDDEN_SPOOF_HEADERS = ["http-referer", "referer", "x-title"];

export function assertNoSpoofHeaders(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (FORBIDDEN_SPOOF_HEADERS.includes(key.toLowerCase())) {
      throw new Error(`Refusing to send spoofed header ${key}`);
    }
  }
}

/** Missing / empty key means auto-update is ON for existing installs. */
export function parseOpencodeAutoUpdate(value: unknown): boolean {
  if (value == null) return true;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return true;
  return normalized !== "false";
}

export function normalizeOpencodeVersion(value: string | null | undefined): string {
  return String(value || "").trim().replace(/^v/i, "");
}

export function isOpencodeVersionOutdated(
  current: string | null | undefined,
  latest: string | null | undefined,
): boolean {
  const installed = normalizeOpencodeVersion(current);
  const published = normalizeOpencodeVersion(latest);
  if (!installed || !published) return false;
  return installed !== published;
}

export function normalizeDownloadProxyUrl(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  const value = String(raw).trim();
  if (!value) return "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Download proxy must be an http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Download proxy must be an http(s) URL");
  }
  return value;
}
