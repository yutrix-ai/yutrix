import crypto from "crypto";

const MAX_SUMMARY_MESSAGES = 12;
const MAX_SUMMARY_TOOLS = 20;
const MAX_JSON_CHARS = 6000;

function safeStringify(value: any): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function shortKeys(value: any): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).slice(0, 20);
}

function findSuspiciousFields(value: any, path = "$", out: string[] = []): string[] {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((item, idx) => findSuspiciousFields(item, `${path}[${idx}]`, out));
    return out;
  }

  for (const [key, child] of Object.entries(value)) {
    if (
      key === "cache_control" ||
      key === "reasoning_content" ||
      key === "extra_content" ||
      key === "thinking" ||
      key === "thinking_content" ||
      key === "provider_specific_fields"
    ) {
      out.push(`${path}.${key}`);
    }
    findSuspiciousFields(child, `${path}.${key}`, out);
  }
  return out;
}

function summarizeText(value: string) {
  return {
    chars: value.length,
    hash: hashText(value),
  };
}

function summarizeContent(content: any): any {
  if (content === null) return { kind: "null" };
  if (content === undefined) return { kind: "undefined" };
  if (typeof content === "string") {
    return { kind: "string", ...summarizeText(content) };
  }
  if (Array.isArray(content)) {
    const textParts = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    return {
      kind: "array",
      partCount: content.length,
      textChars: textParts.length,
      textHash: textParts ? hashText(textParts) : undefined,
      parts: content.slice(0, 10).map((part) => {
        if (!part || typeof part !== "object") return { kind: typeof part };
        return {
          type: part.type,
          keys: shortKeys(part),
          text: typeof part.text === "string" ? summarizeText(part.text) : undefined,
          imageUrlType: part.image_url ? typeof part.image_url : undefined,
          hasCacheControl: !!part.cache_control,
        };
      }),
    };
  }
  if (typeof content === "object") {
    return {
      kind: "object",
      type: content.type,
      keys: shortKeys(content),
      text: typeof content.text === "string" ? summarizeText(content.text) : undefined,
    };
  }
  return { kind: typeof content };
}

function summarizeToolCalls(toolCalls: any): any {
  if (!Array.isArray(toolCalls)) return undefined;
  return {
    count: toolCalls.length,
    calls: toolCalls.slice(0, 10).map((call) => {
      const args = call?.function?.arguments;
      const argsText = typeof args === "string" ? args : safeStringify(args);
      return {
        id: call?.id,
        type: call?.type,
        name: call?.function?.name,
        argsChars: argsText.length,
        argsHash: hashText(argsText),
      };
    }),
  };
}

function summarizeMessage(message: any, index: number): any {
  return {
    index,
    role: message?.role,
    keys: shortKeys(message),
    content: summarizeContent(message?.content),
    toolCalls: summarizeToolCalls(message?.tool_calls),
    toolCallId: message?.tool_call_id,
    name: message?.name,
  };
}

function selectMessages(messages: any[]): any[] {
  if (messages.length <= MAX_SUMMARY_MESSAGES) {
    return messages.map(summarizeMessage);
  }

  const head = messages.slice(0, 2).map(summarizeMessage);
  const tailStart = messages.length - (MAX_SUMMARY_MESSAGES - 2);
  const tail = messages.slice(tailStart).map((message, idx) => summarizeMessage(message, tailStart + idx));
  return [
    ...head,
    { omittedMessages: messages.length - MAX_SUMMARY_MESSAGES },
    ...tail,
  ];
}

export function buildUpstreamRequestDiagnostic(body: any, meta: Record<string, any> = {}, omitPayloadDetails: boolean = false): string {
  if (omitPayloadDetails) {
    return safeStringify(meta);
  }

  const bodyText = safeStringify(body);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const suspicious = findSuspiciousFields(body).slice(0, 50);

  const summary = {
    ...meta,
    bodyBytes: Buffer.byteLength(bodyText),
    bodyHash: hashText(bodyText),
    rootKeys: shortKeys(body),
    model: body?.model,
    stream: body?.stream,
    streamOptions: body?.stream_options,
    maxTokens: body?.max_tokens,
    maxCompletionTokens: body?.max_completion_tokens,
    toolChoice: body?.tool_choice,
    messageCount: messages.length,
    messages: selectMessages(messages),
    toolCount: tools.length,
    tools: tools.slice(0, MAX_SUMMARY_TOOLS).map((tool: any) => ({
      type: tool?.type,
      name: tool?.function?.name || tool?.name,
      functionKeys: shortKeys(tool?.function),
      parameterKeys: shortKeys(tool?.function?.parameters || tool?.input_schema),
    })),
    omittedTools: tools.length > MAX_SUMMARY_TOOLS ? tools.length - MAX_SUMMARY_TOOLS : 0,
    suspiciousFields: suspicious,
  };

  const text = safeStringify(summary);
  return text.length > MAX_JSON_CHARS ? `${text.slice(0, MAX_JSON_CHARS)}...<truncated>` : text;
}
