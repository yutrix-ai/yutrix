import { exactEstimateTokens } from "./tokenizer";

export type UsageStatus = "success" | "estimated" | "missing" | "failed";

export type UsageLogValues = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  usageStatus: UsageStatus;
};

export function readTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

export function firstTokenCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    const tokenCount = readTokenCount(value);
    if (tokenCount !== undefined) return tokenCount;
  }
  return undefined;
}

export function sumTokenCounts(...values: unknown[]): number | undefined {
  let total = 0;
  let found = false;
  for (const value of values) {
    const tokenCount = readTokenCount(value);
    if (tokenCount !== undefined) {
      total += tokenCount;
      found = true;
    }
  }
  return found ? total : undefined;
}

export function normalizeUsagePayload(payload: any) {
  const usage = payload?.usage || payload?.message?.usage;
  if (!usage || typeof usage !== "object") return null;

  const anthropicInputTokens = sumTokenCounts(
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  );
  const inputTokens = firstTokenCount(usage.prompt_tokens, anthropicInputTokens);
  const outputTokens = firstTokenCount(usage.completion_tokens, usage.output_tokens);

  let calculatedTotal: number | undefined;
  if (inputTokens !== undefined || outputTokens !== undefined) {
    calculatedTotal = (inputTokens || 0) + (outputTokens || 0);
  }

  const totalTokens = firstTokenCount(
    calculatedTotal,
    usage.total_tokens,
  );

  const cachedTokens = firstTokenCount(usage.cached_tokens, usage.cache_read_input_tokens) || 0;

  const cacheReadTokens = firstTokenCount(
    usage.cache_read_input_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.cached_tokens
  ) || 0;

  const cacheWriteTokens = firstTokenCount(
    usage.cache_creation_input_tokens
  ) || 0;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return null;
  }

  return { inputTokens, outputTokens, totalTokens, cachedTokens, cacheReadTokens, cacheWriteTokens };
}

export function stringifyForTokenEstimate(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

export function extractText(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("\n");
  }
  if (typeof value !== "object") return "";
  if (value.type === "image" || value.type === "image_url") {
    const isHigh = value.image_url?.detail === "high" || value.source?.detail === "high";
    const tokens = isHigh ? 170 : 85;
    return "img ".repeat(tokens).trim();
  }

  const parts: string[] = [];
  if (typeof value.text === "string") parts.push(value.text);
  if (value.content !== undefined) parts.push(extractText(value.content));
  if (value.input !== undefined) {
    parts.push(stringifyForTokenEstimate({ name: value.name, input: value.input }));
  }
  if (value.tool_calls !== undefined) {
    parts.push(stringifyForTokenEstimate(value.tool_calls));
  }
  if (value.function_call !== undefined) {
    parts.push(stringifyForTokenEstimate(value.function_call));
  }

  return parts.filter(Boolean).join("\n");
}

export function extractPromptText(body: any): string {
  if (!body) return "";

  const parts: string[] = [];
  const systemText = extractText(body.system);
  if (systemText) parts.push(systemText);

  if (body.systemInstruction) {
    if (Array.isArray(body.systemInstruction.parts)) {
      for (const part of body.systemInstruction.parts) {
        if (typeof part.text === "string" && part.text) {
          parts.push(part.text);
        }
      }
    }
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const messageText = extractText(message);
      if (messageText) parts.push(messageText);
    }
  }

  if (Array.isArray(body.contents)) {
    for (const content of body.contents) {
      if (Array.isArray(content.parts)) {
        for (const part of content.parts) {
          if (typeof part.text === "string" && part.text) {
            parts.push(part.text);
          }
        }
      }
    }
  }

  const promptText = extractText(body.prompt);
  if (promptText) parts.push(promptText);

  return parts.join("\n").trim();
}

export function extractCompletionText(payload: any, streamedText = ""): string {
  if (streamedText) return streamedText;
  if (!payload) return "";

  const firstChoice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  return (
    extractText(firstChoice?.message?.content) ||
    extractText(firstChoice?.text) ||
    extractText(payload.content) ||
    extractText(payload.completion)
  );
}

export function extractCompletionMaterialForTokenEstimate(
  payload: any,
  streamedText = "",
  streamedReasoning = "",
  streamedToolCalls: any[] = []
): string {
  const parts: string[] = [];

  if (streamedText) parts.push(streamedText);
  if (streamedReasoning) parts.push(streamedReasoning);
  if (streamedToolCalls && streamedToolCalls.length > 0) {
    parts.push(stringifyForTokenEstimate(streamedToolCalls));
  }

  if (payload) {
    if (Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        const msg = choice?.message || choice?.delta;
        if (msg) {
          if (typeof msg.content === "string" && msg.content) {
            parts.push(msg.content);
          }
          if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
            parts.push(msg.reasoning_content);
          }
          if (typeof msg.reasoning === "string" && msg.reasoning) {
            parts.push(msg.reasoning);
          }
          if (msg.reasoning_details) {
            parts.push(stringifyForTokenEstimate(msg.reasoning_details));
          }
          if (msg.tool_calls) {
            parts.push(stringifyForTokenEstimate(msg.tool_calls));
          }
          if (msg.function_call) {
            parts.push(stringifyForTokenEstimate(msg.function_call));
          }
        }
        if (typeof choice?.text === "string" && choice.text) {
          parts.push(choice.text);
        }
      }
    }

    if (Array.isArray(payload.content)) {
      for (const block of payload.content) {
        if (block) {
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            parts.push(block.text);
          }
          if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
            parts.push(block.thinking);
          }
          if (block.type === "tool_use") {
            parts.push(stringifyForTokenEstimate({ name: block.name, input: block.input }));
          }
        }
      }
    }

    if (typeof payload.completion === "string" && payload.completion) {
      parts.push(payload.completion);
    }
  }

  return parts.filter(Boolean).join("\n");
}

export interface ProviderUsagePresence {
  inputProvided: boolean;
  outputProvided: boolean;
  cacheReadProvided: boolean;
  cacheWriteProvided: boolean;
}

export function detectProviderUsagePresence(data: any): ProviderUsagePresence {
  const presence = {
    inputProvided: false,
    outputProvided: false,
    cacheReadProvided: false,
    cacheWriteProvided: false,
  };
  if (!data || typeof data !== "object") return presence;

  const usage = data.usage || data.message?.usage;
  if (usage && typeof usage === "object") {
    if (usage.hasOwnProperty("prompt_tokens") || usage.hasOwnProperty("input_tokens")) {
      presence.inputProvided = true;
    }
    if (usage.hasOwnProperty("completion_tokens") || usage.hasOwnProperty("output_tokens")) {
      presence.outputProvided = true;
    }
    if (
      usage.hasOwnProperty("cache_read_input_tokens") ||
      (usage.prompt_tokens_details && usage.prompt_tokens_details.hasOwnProperty("cached_tokens")) ||
      usage.hasOwnProperty("cached_tokens")
    ) {
      presence.cacheReadProvided = true;
    }
    if (usage.hasOwnProperty("cache_creation_input_tokens")) {
      presence.cacheWriteProvided = true;
    }
  }
  return presence;
}

export async function resolveUsageForLog(
  usagePayload: any,
  requestBody: any,
  modelId: string,
  responsePayload?: any,
  streamedCompletionText = "",
  tokenizerRepo?: string | null,
  proxyUrl?: string | null,
): Promise<UsageLogValues> {
  const normalizedUsage = normalizeUsagePayload(usagePayload);
  if (normalizedUsage) {
    const inputTokens = normalizedUsage.inputTokens || 0;
    const outputTokens = normalizedUsage.outputTokens || 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: normalizedUsage.totalTokens || inputTokens + outputTokens,
      cachedTokens: normalizedUsage.cachedTokens || 0,
      usageStatus: "success",
    };
  }

  const inputTokens = await exactEstimateTokens(extractPromptText(requestBody), modelId, proxyUrl, tokenizerRepo);
  const outputTokens = await exactEstimateTokens(
    extractCompletionText(responsePayload, streamedCompletionText),
    modelId,
    proxyUrl,
    tokenizerRepo
  );
  const totalTokens = inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens: 0,
    usageStatus: totalTokens > 0 ? "estimated" : "missing",
  };
}

export function parseSseDataLine(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  return line.slice(5).trimStart();
}

export function captureRoundOutputSnapshot(data: any, observation?: any): any {
  return {
    completionMaterial: extractCompletionMaterialForTokenEstimate(data),
    completionText: extractCompletionText(data),
    reasoningText: observation?.reasoningText || "",
    toolCallSerialization: data?.choices?.[0]?.message?.tool_calls ? JSON.stringify(data.choices[0].message.tool_calls) : "",
  };
}
