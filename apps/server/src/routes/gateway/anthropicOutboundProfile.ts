export interface AnthropicOutboundSurface {
  hostname?: string;
  pathname?: string;
  rawBaseUrl?: string;
}

function hostFromSurface(surface?: AnthropicOutboundSurface | null): string {
  if (!surface) return "";
  if (surface.hostname && surface.hostname.trim()) {
    return surface.hostname.trim().toLowerCase();
  }
  const raw = surface.rawBaseUrl || "";
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Official Claude surfaces keep full Anthropic dialect.
 * Missing host is treated as first-party so existing callers stay passthrough.
 */
export function isFirstPartyAnthropicSurface(
  surface?: AnthropicOutboundSurface | null,
): boolean {
  const host = hostFromSurface(surface);
  if (!host) return true;
  if (host === "api.anthropic.com" || host.endsWith(".anthropic.com")) return true;
  if (host.includes("bedrock-runtime") && host.endsWith(".amazonaws.com")) return true;
  if (
    host.endsWith(".googleapis.com") &&
    (host.includes("aiplatform") || host.includes("vertex"))
  ) {
    return true;
  }
  return false;
}

function thinkingText(block: any): string {
  if (!block || typeof block !== "object") return "";
  if (typeof block.thinking === "string" && block.thinking.trim()) return block.thinking;
  if (typeof block.text === "string" && block.text.trim()) return block.text;
  return "";
}

function stripCacheControl<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripCacheControl(item)) as T;
  }
  const next: Record<string, any> = {};
  for (const [key, child] of Object.entries(value as Record<string, any>)) {
    if (key === "cache_control") continue;
    next[key] = stripCacheControl(child);
  }
  return next as T;
}

function normalizeContentBlocks(content: any): any {
  if (!Array.isArray(content)) return content;
  const out: any[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      out.push(block);
      continue;
    }
    const type = String(block.type || "");
    if (type === "thinking" || type === "thinking_content") {
      const text = thinkingText(block);
      if (text) out.push({ type: "text", text });
      continue;
    }
    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(block)) {
      if (key === "cache_control" || key === "signature" || key === "thoughtSignature") {
        continue;
      }
      cleaned[key] = stripCacheControl(value);
    }
    out.push(cleaned);
  }
  return out;
}

function normalizeCompatibleTool(tool: any): any {
  if (!tool || typeof tool !== "object") return tool;
  const next: Record<string, any> = {};
  if (typeof tool.name === "string") next.name = tool.name;
  if (tool.description !== undefined) next.description = tool.description;
  if (tool.input_schema !== undefined) next.input_schema = stripCacheControl(tool.input_schema);
  return next;
}

/**
 * Reduce a Claude Code dialect body to the portable Anthropic-compatible subset
 * unofficial /v1/messages proxies typically accept.
 */
export function normalizeCompatibleAnthropicBody(body: any): any {
  if (!body || typeof body !== "object") return body;
  const next = stripCacheControl({ ...body });

  if (Array.isArray(next.system)) {
    next.system = next.system.map((block: any) => {
      if (!block || typeof block !== "object") return block;
      const cleaned: Record<string, any> = {};
      for (const [key, value] of Object.entries(block)) {
        if (key === "cache_control") continue;
        cleaned[key] = stripCacheControl(value);
      }
      return cleaned;
    });
  }

  if (Array.isArray(next.messages)) {
    next.messages = next.messages.map((msg: any) => {
      if (!msg || typeof msg !== "object") return msg;
      const copy = { ...msg };
      if (Array.isArray(copy.content)) {
        copy.content = normalizeContentBlocks(copy.content);
      }
      return copy;
    });
  }

  if (Array.isArray(next.tools)) {
    next.tools = next.tools.map(normalizeCompatibleTool);
  }

  if (typeof next.max_tokens !== "number" || next.max_tokens < 1) {
    next.max_tokens = 1;
  }

  return next;
}

export function applyAnthropicCompatibleOutbound(
  body: any,
  surface: AnthropicOutboundSurface | undefined,
  modelId: string,
): any {
  if (!body || typeof body !== "object") return body;
  if (isFirstPartyAnthropicSurface(surface)) {
    return body;
  }
  const next = normalizeCompatibleAnthropicBody(body);
  if (modelId) next.model = modelId;
  return next;
}
