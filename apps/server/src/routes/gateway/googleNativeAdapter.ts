import crypto from "crypto";
import { parseSseDataLine } from "../../utils/gatewayContent";
import {
  isGoogleOpenAICompatibleProvider,
  sanitizeGeminiSchema,
} from "./providerCompatibility";

type GoogleNativeRequestOptions = {
  body: any;
  baseUrl: string;
  modelId: string;
  isStreaming: boolean;
  providerName?: string;
  providerProtocol?: string;
};

export type GoogleNativeRequest = {
  baseUrl: string;
  upstreamPath: string;
  body: any;
};

const RESPONSE_ONLY_PART_TYPES = new Set([
  "reasoning",
  "reasoning_content",
  "thinking",
  "thinking_content",
  "redacted_reasoning",
]);

function isGoogleNativeDisabled(): boolean {
  return String(process.env.GOOGLE_NATIVE_ADAPTER || "").toLowerCase() === "false";
}

export function shouldUseGoogleNativeAdapter(options: {
  providerName?: string;
  baseUrl?: string;
  providerProtocol?: string;
}): boolean {
  if (isGoogleNativeDisabled()) return false;
  if (!options.baseUrl) return false;
  try {
    const parsed = new URL(options.baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === "googleapis.com" || hostname.endsWith(".googleapis.com");
  } catch (_) {
    return false;
  }
}

export function buildGoogleNativeHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };
}

export function normalizeGoogleNativeBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const versionMatch = url.pathname.match(/\/(v1(?:beta)?)/);
    const version = versionMatch?.[1] || "v1beta";
    return `${url.origin}/${version}`;
  } catch {
    return "https://generativelanguage.googleapis.com/v1beta";
  }
}

/**
 * Return origin-only base URL for use with @google/genai SDK.
 * The SDK internally appends the API version path (e.g. /v1beta),
 * so we must NOT include it in httpOptions.baseUrl.
 */
export function googleNativeBaseUrlOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "https://generativelanguage.googleapis.com";
  }
}

function modelPath(modelId: string): string {
  const raw = modelId.replace(/^models\//, "");
  return `/models/${encodeURIComponent(raw)}`;
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = url.match(/^data:([^;,]+);base64,(.*)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return { value };
  }
}

function responseFromToolContent(content: any): any {
  if (typeof content === "string") {
    const parsed = safeJsonParse(content);
    if (parsed && typeof parsed === "object") return parsed;
    return { result: content };
  }
  if (Array.isArray(content)) {
    return {
      result: content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part?.type === "text") return String(part.text ?? "");
          return JSON.stringify(part ?? "");
        })
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (content && typeof content === "object") return content;
  return { result: String(content ?? "") };
}

function openAIContentToGoogleParts(content: any): any[] {
  if (content === undefined || content === null || content === "") return [];
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [{ text: JSON.stringify(content) }];

  const parts: any[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const type = String(block.type || "");
    if (RESPONSE_ONLY_PART_TYPES.has(type)) continue;

    if (type === "text") {
      const text = typeof block.text === "string" ? block.text : String(block.text ?? "");
      if (text) parts.push({ text });
      continue;
    }

    if (type === "image_url") {
      const imageUrl =
        typeof block.image_url === "string"
          ? block.image_url
          : typeof block.image_url?.url === "string"
            ? block.image_url.url
            : "";
      const dataUrl = parseDataUrl(imageUrl);
      if (dataUrl) {
        parts.push({
          inlineData: {
            mimeType: dataUrl.mimeType,
            data: dataUrl.data,
          },
        });
      } else if (imageUrl) {
        parts.push({ text: imageUrl });
      }
      continue;
    }

    if (type === "input_image" || type === "input-image") {
      const rawImage =
        typeof block.image === "string"
          ? block.image
          : typeof block.url === "string"
            ? block.url
            : typeof block.image_url?.url === "string"
              ? block.image_url.url
              : "";
      const dataUrl = parseDataUrl(rawImage);
      if (dataUrl) {
        parts.push({
          inlineData: {
            mimeType: dataUrl.mimeType,
            data: dataUrl.data,
          },
        });
      }
      continue;
    }

    if (block.text !== undefined) {
      parts.push({ text: String(block.text ?? "") });
    }
  }

  return parts.filter((part) => {
    if (typeof part.text === "string") return part.text.length > 0;
    return true;
  });
}

function collectSystemText(message: any): string {
  return openAIContentToGoogleParts(message?.content)
    .map((part) => part.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function openAIToolsToGoogleTools(tools: any[] | undefined): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  const functionDeclarations = tools
    .map((tool) => {
      const fn = tool?.type === "function" ? tool.function : tool;
      if (!fn?.name) return null;
      const declaration: Record<string, any> = {
        name: fn.name,
      };
      if (fn.description !== undefined) declaration.description = fn.description;
      if (fn.parameters !== undefined) declaration.parameters = sanitizeGeminiSchema(fn.parameters);
      return declaration;
    })
    .filter(Boolean);

  if (functionDeclarations.length === 0) return undefined;
  return [{ functionDeclarations }];
}

function openAIToolChoiceToGoogleConfig(toolChoice: any): any | undefined {
  if (!toolChoice || toolChoice === "auto") return undefined;
  if (toolChoice === "none") {
    return { functionCallingConfig: { mode: "NONE" } };
  }
  if (toolChoice === "required") {
    return { functionCallingConfig: { mode: "ANY" } };
  }
  if (toolChoice?.type === "function" && toolChoice.function?.name) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [toolChoice.function.name],
      },
    };
  }
  return undefined;
}

function generationConfigFromOpenAI(body: any): any | undefined {
  const config: Record<string, any> = {};
  const maxOutputTokens = body?.max_completion_tokens ?? body?.max_tokens;
  if (typeof maxOutputTokens === "number") config.maxOutputTokens = maxOutputTokens;
  if (typeof body?.temperature === "number") config.temperature = body.temperature;
  if (typeof body?.top_p === "number") config.topP = body.top_p;
  if (Array.isArray(body?.stop) && body.stop.length > 0) config.stopSequences = body.stop;
  if (typeof body?.stop === "string") config.stopSequences = [body.stop];
  return Object.keys(config).length > 0 ? config : undefined;
}

function appendAssistantToolCalls(
  parts: any[],
  toolCalls: any[] | undefined,
  toolNameById: Map<string, string>,
): void {
  if (!Array.isArray(toolCalls)) return;
  for (const toolCall of toolCalls) {
    const name = toolCall?.function?.name || "";
    if (!name) continue;
    const id = toolCall.id || `call_${crypto.randomUUID()}`;
    toolNameById.set(id, name);
    parts.push({
      functionCall: {
        name,
        args:
          typeof toolCall.function?.arguments === "string"
            ? safeJsonParse(toolCall.function.arguments)
            : toolCall.function?.arguments || {},
      },
    });
  }
}

function openAIMessagesToGoogle(body: any): { contents: any[]; systemInstruction?: any } {
  const contents: any[] = [];
  const systemTexts: string[] = [];
  const toolNameById = new Map<string, string>();

  const addContentPart = (role: "user" | "model", part: any) => {
    const lastContent = contents[contents.length - 1];
    if (lastContent && lastContent.role === role) {
      lastContent.parts.push(part);
    } else {
      contents.push({ role, parts: [part] });
    }
  };

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    const role = message?.role;
    if (role === "system" || role === "developer") {
      const systemText = collectSystemText(message);
      if (systemText) systemTexts.push(systemText);
      continue;
    }

    if (role === "assistant") {
      const parts = openAIContentToGoogleParts(message.content);
      const assistantParts: any[] = [...parts];
      appendAssistantToolCalls(assistantParts, message.tool_calls, toolNameById);
      for (const part of assistantParts) {
        addContentPart("model", part);
      }
      continue;
    }

    if (role === "tool") {
      const name = toolNameById.get(message.tool_call_id) || message.name || "tool_result";
      addContentPart("user", {
        functionResponse: {
          name,
          response: responseFromToolContent(message.content),
        },
      });
      continue;
    }

    const parts = openAIContentToGoogleParts(message?.content);
    for (const part of parts) {
      addContentPart("user", part);
    }
  }

  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: "" }] });
  }

  const systemText = systemTexts.join("\n\n").trim();
  return {
    contents,
    systemInstruction: systemText
      ? { parts: [{ text: systemText }] }
      : undefined,
  };
}

export function buildGoogleNativeRequest(options: GoogleNativeRequestOptions): GoogleNativeRequest | null {
  if (!shouldUseGoogleNativeAdapter(options)) return null;

  const { contents, systemInstruction } = openAIMessagesToGoogle(options.body);
  const nativeBody: Record<string, any> = { contents };
  if (systemInstruction) nativeBody.systemInstruction = systemInstruction;

  const tools = openAIToolsToGoogleTools(options.body?.tools);
  if (tools) nativeBody.tools = tools;

  const toolConfig = openAIToolChoiceToGoogleConfig(options.body?.tool_choice);
  if (toolConfig) nativeBody.toolConfig = toolConfig;

  const generationConfig = generationConfigFromOpenAI(options.body);
  if (generationConfig) nativeBody.generationConfig = generationConfig;

  const method = options.isStreaming ? "streamGenerateContent" : "generateContent";
  const query = options.isStreaming ? "?alt=sse" : "";
  return {
    baseUrl: normalizeGoogleNativeBaseUrl(options.baseUrl),
    upstreamPath: `${modelPath(options.modelId)}:${method}${query}`,
    body: nativeBody,
  };
}

function mapGoogleFinishReason(reason: any, hasToolCalls: boolean): string | null {
  if (hasToolCalls) return "tool_calls";
  const normalized = String(reason || "").toUpperCase();
  if (!normalized) return null;
  if (normalized === "STOP") return "stop";
  if (normalized === "MAX_TOKENS") return "length";
  if (normalized === "SAFETY" || normalized === "PROHIBITED_CONTENT") return "content_filter";
  return normalized.toLowerCase();
}

function usageFromGoogle(data: any): any | undefined {
  const usage = data?.usageMetadata;
  if (!usage || typeof usage !== "object") return undefined;
  const promptTokens = usage.promptTokenCount || 0;
  const completionTokens =
    usage.candidatesTokenCount ??
    Math.max((usage.totalTokenCount || 0) - promptTokens, 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokenCount || promptTokens + completionTokens,
    completion_tokens_details:
      usage.thoughtsTokenCount !== undefined
        ? { reasoning_tokens: usage.thoughtsTokenCount }
        : undefined,
  };
}

export function googleGenerateContentToOpenAI(data: any, modelId: string): any {
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  let content = "";
  let reasoningContent = "";
  const toolCalls: any[] = [];

  for (const part of parts) {
    if (typeof part?.text === "string") {
      if (part.thought === true) {
        reasoningContent += part.text;
      } else {
        content += part.text;
      }
    }
    if (part?.functionCall?.name) {
      toolCalls.push({
        id: part.functionCall.id || `call_${crypto.randomUUID()}`,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
    }
  }

  const message: Record<string, any> = {
    role: "assistant",
    content: content || (toolCalls.length > 0 ? null : ""),
  };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const usage = usageFromGoogle(data);
  return {
    id: data?.responseId || `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: mapGoogleFinishReason(candidate?.finishReason, toolCalls.length > 0),
      },
    ],
    usage,
  };
}

function googleChunkToOpenAIChunks(data: any, modelId: string, state: any): any[] {
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const chunks: any[] = [];
  const base = {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: modelId,
  };

  for (const part of parts) {
    if (typeof part?.text === "string" && part.text) {
      const delta: Record<string, any> = {};
      if (!state.roleSent) {
        delta.role = "assistant";
        state.roleSent = true;
      }
      if (part.thought === true) {
        delta.reasoning_content = part.text;
      } else {
        delta.content = part.text;
      }
      chunks.push({
        ...base,
        choices: [{ index: 0, delta, logprobs: null, finish_reason: null }],
      });
    }

    if (part?.functionCall?.name) {
      const index = state.nextToolIndex++;
      const id = part.functionCall.id || `call_${crypto.randomUUID()}`;
      if (!state.roleSent) {
        state.roleSent = true;
      }
      state.hasToolCalls = true;
      chunks.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id,
                  type: "function",
                  function: {
                    name: part.functionCall.name,
                    arguments: "",
                  },
                },
              ],
            },
            logprobs: null,
            finish_reason: null,
          },
        ],
      });

      const args = JSON.stringify(part.functionCall.args || {});
      if (args) {
        chunks.push({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    function: {
                      arguments: args,
                    },
                  },
                ],
              },
              logprobs: null,
              finish_reason: null,
            },
          ],
        });
      }
    }
  }

  const finishReason = mapGoogleFinishReason(candidate?.finishReason, state.hasToolCalls);
  const usage = usageFromGoogle(data);
  if (finishReason || usage) {
    state.terminalSent = true;
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: state.roleSent ? {} : { role: "assistant" },
          logprobs: null,
          finish_reason: finishReason,
        },
      ],
      usage,
    });
    state.roleSent = true;
  }

  return chunks;
}

function buildOpenAITerminalChunk(modelId: string, state: any): any {
  state.terminalSent = true;
  return {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: modelId,
    choices: [
      {
        index: 0,
        delta: state.roleSent ? {} : { role: "assistant" },
        logprobs: null,
        finish_reason: state.hasToolCalls ? "tool_calls" : "stop",
      },
    ],
  };
}

export function googleNativeStreamToOpenAIStream(
  upstream: ReadableStream | any,
  modelId: string,
): ReadableStream {
  const reader = upstream.getReader();
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  const state = {
    id: `chatcmpl_${crypto.randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    roleSent: false,
    hasToolCalls: false,
    terminalSent: false,
    nextToolIndex: 0,
  };

  return new ReadableStream({
    async start(controller) {
      let buffer = "";
      let doneSent = false;
      const emit = (payload: string) => controller.enqueue(encoder.encode(payload));

      try {
        emit(`data: ${JSON.stringify({
          id: state.id,
          object: "chat.completion.chunk",
          created: state.created,
          model: modelId,
          choices: [
            {
              index: 0,
              delta: { role: "assistant" },
              logprobs: null,
              finish_reason: null,
            },
          ],
        })}\n\n`);
        state.roleSent = true;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) break;
            const rawLine = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            const dataText = parseSseDataLine(rawLine.trim());
            if (!dataText) continue;
            if (dataText === "[DONE]") {
              doneSent = true;
              if (!state.terminalSent) {
                emit(`data: ${JSON.stringify(buildOpenAITerminalChunk(modelId, state))}\n\n`);
              }
              emit("data: [DONE]\n\n");
              continue;
            }
            const data = JSON.parse(dataText);
            if (data?.error) {
              throw new Error(JSON.stringify(data.error));
            }
            for (const chunk of googleChunkToOpenAIChunks(data, modelId, state)) {
              emit(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          }
        }

        const trailing = buffer.trim();
        if (trailing) {
          const dataText = parseSseDataLine(trailing);
          if (dataText && dataText !== "[DONE]") {
            const data = JSON.parse(dataText);
            if (data?.error) {
              throw new Error(JSON.stringify(data.error));
            }
            for (const chunk of googleChunkToOpenAIChunks(data, modelId, state)) {
              emit(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          }
        }

        if (!doneSent) {
          if (!state.terminalSent) {
            emit(`data: ${JSON.stringify(buildOpenAITerminalChunk(modelId, state))}\n\n`);
          }
          emit("data: [DONE]\n\n");
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

export function googleGenAIStreamToOpenAIStream(
  sdkStream: AsyncGenerator<any> | any,
  modelId: string,
): ReadableStream {
  const encoder = new TextEncoder();
  const state = {
    id: `chatcmpl_${crypto.randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    roleSent: false,
    hasToolCalls: false,
    terminalSent: false,
    nextToolIndex: 0,
  };

  return new ReadableStream({
    async start(controller) {
      const emit = (payload: string) => controller.enqueue(encoder.encode(payload));

      try {
        emit(`data: ${JSON.stringify({
          id: state.id,
          object: "chat.completion.chunk",
          created: state.created,
          model: modelId,
          choices: [
            {
              index: 0,
              delta: { role: "assistant" },
              logprobs: null,
              finish_reason: null,
            },
          ],
        })}\n\n`);
        state.roleSent = true;

        for await (const chunk of sdkStream) {
          for (const openAIChunk of googleChunkToOpenAIChunks(chunk, modelId, state)) {
            emit(`data: ${JSON.stringify(openAIChunk)}\n\n`);
          }
        }

        if (!state.terminalSent) {
          emit(`data: ${JSON.stringify(buildOpenAITerminalChunk(modelId, state))}\n\n`);
        }
        emit("data: [DONE]\n\n");
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      if (sdkStream && typeof sdkStream.return === "function") {
        sdkStream.return().catch(() => {});
      }
    },
  });
}

