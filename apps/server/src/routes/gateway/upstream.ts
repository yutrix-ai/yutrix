import crypto from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import type { ProxyAgent } from "undici";
import type { UpstreamResponseData } from "./types";
import { detectProviderUsagePresence, extractCompletionText, captureRoundOutputSnapshot } from "../../utils/gatewayContent";
import { readUpstreamError } from "../../utils/gatewayError";
import { activeTranslators } from "./translators";
import {
  googleGenerateContentToOpenAI,
  googleNativeStreamToOpenAIStream,
  normalizeGoogleNativeBaseUrl,
  googleNativeBaseUrlOrigin,
  googleGenAIStreamToOpenAIStream,
} from "./googleNativeAdapter";

// Create AsyncLocalStorage for fetch context (upstreamProxyUrl propagation)
export const fetchContextStorage = new AsyncLocalStorage<{
  upstreamProxyUrl?: string;
}>();

// Cache ProxyAgent instances to reuse TCP connections (keep-alive)
const proxyAgentCache = new Map<string, ProxyAgent>();
async function getProxyAgent(proxyUrl: string): Promise<ProxyAgent> {
  let agent = proxyAgentCache.get(proxyUrl);
  if (!agent) {
    const { ProxyAgent: PA } = await import("undici");
    agent = new PA(proxyUrl);
    proxyAgentCache.set(proxyUrl, agent);
  }
  return agent;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async function (input: any, init: any) {
  const store = fetchContextStorage.getStore();
  if (store?.upstreamProxyUrl) {
    const { fetch: undiciFetch } = await import("undici");
    const dispatcher = await getProxyAgent(store.upstreamProxyUrl);

    let url = input;
    let finalInit = { ...init, dispatcher };

    // If input is a native Request object, undici.fetch might fail to parse it
    // Convert it to string URL and extract its properties
    if (input && typeof input === "object" && input.url) {
      url = input.url;
      finalInit = {
        method: input.method,
        headers: input.headers,
        body: input.body,
        ...init,
        dispatcher,
      };
    }

    return undiciFetch(url, finalInit as any) as any;
  }
  return originalFetch(input, init);
};

// ---------------------------------------------------------------------------
// Upstream header construction
// ---------------------------------------------------------------------------

/**
 * Build the HTTP headers for the upstream provider request.
 *
 * - Anthropic endpoints use `x-api-key` + `anthropic-version`
 * - All other providers use `Authorization: Bearer …`
 * - Special user-agent headers for certain request paths
 */
export function buildUpstreamHeaders(
  decryptedKey: string,
  isAnthropicUpstream: boolean,
  reqPath: string,
): Record<string, string> {
  let upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (isAnthropicUpstream) {
    upstreamHeaders["x-api-key"] = decryptedKey as string;
    upstreamHeaders["anthropic-version"] = "2023-06-01";
  } else {
    upstreamHeaders["Authorization"] = `Bearer ${decryptedKey}`;
  }

  if (reqPath.startsWith("/v0/messages")) {
    upstreamHeaders["x-anthropic-client"] = "claude-code";
    upstreamHeaders["user-agent"] = "claude-code/1.0.0";
  } else if (reqPath.startsWith("/v0/chat/completions")) {
    upstreamHeaders["user-agent"] = "Codex-CLI";
  }

  return upstreamHeaders;
}

// ---------------------------------------------------------------------------
// Upstream path determination
// ---------------------------------------------------------------------------

/**
 * Determine the upstream API path based on the provider protocol and incoming
 * request path.
 */
export function determineUpstreamPath(
  isAnthropicUpstream: boolean,
  reqPath: string,
): string {
  let upstreamPath = "/chat/completions";
  if (isAnthropicUpstream) {
    upstreamPath =
      reqPath === "/v1/complete" ? "/v1/complete" : "/v1/messages";
  }
  return upstreamPath;
}

// ---------------------------------------------------------------------------
// Upstream fetch configuration
// ---------------------------------------------------------------------------

export interface UpstreamFetchConfig {
  baseUrl: string;
  upstreamPath: string;
  upstreamHeaders: Record<string, string>;
  finalBody: any;
  controller: AbortController;
  provider: any;
  isStreaming: boolean;
  modelId: string;
  holdProv: () => () => void;
  holdUser: () => () => void;
  holdGlobal: () => () => void;
  /** Milliseconds already spent waiting in the queue before this attempt. */
  queueMs: number;
  /** Timestamp (Date.now()) when this attempt started processing. */
  attemptStartProcessingMs: number;
  /** Shared base action log context. */
  baseLog: any;
  /** Timeout id to clear on response / error. */
  timeoutId: NodeJS.Timeout | undefined;
  /** Current attempt state (needed for error enrichment). */
  currentAttempt: {
    providerProtocol: string;
    modelId: string;
    isFallback: boolean;
    fallbackReason: string;
  };
  /** Incoming protocol – used for non-streaming Anthropic conversion. */
  incomingProtocol: string;
  /** Whether the upstream is an Anthropic-protocol provider. */
  isAnthropicUpstream: boolean;
  isGoogleNativeUpstream?: boolean;
  adapter?: any;
  adapterContext?: any;
  adapterState?: any;
  roundId?: string;
}

// ---------------------------------------------------------------------------
// Upstream fetch execution
// ---------------------------------------------------------------------------

/**
 * Execute the upstream fetch request and return a normalised
 * `UpstreamResponseData` result.
 *
 * Handles:
 * - Proxy support via undici ProxyAgent
 * - Non-OK responses → error objects
 * - Streaming requests that receive `application/json` → fake SSE stream
 * - Normal streaming → piped ReadableStream with concurrency hold
 * - Non-streaming → parsed JSON (with Anthropic protocol conversion)
 * - Error enrichment with upstream context on throw
 */
export async function executeUpstreamFetch(
  config: UpstreamFetchConfig,
): Promise<UpstreamResponseData> {
  const {
    baseUrl,
    adapter,
    adapterContext,
    upstreamPath,
    upstreamHeaders,
    finalBody,
    controller,
    provider,
    isStreaming,
    modelId,
    holdProv,
    holdUser,
    holdGlobal,
    queueMs,
    attemptStartProcessingMs,
    baseLog,
    timeoutId,
    currentAttempt,
    incomingProtocol,
    isAnthropicUpstream,
    isGoogleNativeUpstream,
    roundId,
  } = config;

  try {
    if (isGoogleNativeUpstream) {
      const apiKey = upstreamHeaders["x-goog-api-key"] || "";
      const { GoogleGenAI } = await import("@google/genai");

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          baseUrl: googleNativeBaseUrlOrigin(baseUrl),
          timeout: provider.timeoutMs > 0 ? provider.timeoutMs : undefined,
        },
      });

      const contents = finalBody.contents;
      const systemInstruction = finalBody.systemInstruction;
      const tools = finalBody.tools;
      const toolConfig = finalBody.toolConfig;
      const generationConfig = finalBody.generationConfig || {};

      const params: any = {
        model: modelId,
        contents,
        config: {
          systemInstruction,
          tools,
          toolConfig,
          temperature: generationConfig.temperature,
          topP: generationConfig.topP,
          topK: generationConfig.topK,
          candidateCount: generationConfig.candidateCount,
          maxOutputTokens: generationConfig.maxOutputTokens,
          stopSequences: generationConfig.stopSequences,
          responseMimeType: generationConfig.responseMimeType,
          responseSchema: generationConfig.responseSchema,
          responseJsonSchema: generationConfig.responseJsonSchema,
          safetySettings: finalBody.safetySettings,
          abortSignal: controller.signal,
        },
      };

      const executeCall = async (): Promise<UpstreamResponseData> => {
        if (isStreaming) {
          const responseStream = await ai.models.generateContentStream(params);
          const stream = googleGenAIStreamToOpenAIStream(responseStream, modelId);
          const releaseProv = holdProv();
          const releaseUser = holdUser();
          const releaseGlobal = holdGlobal();
          return {
            status: 200,
            stream,
            isStream: true,
            latencyMs: Date.now() - attemptStartProcessingMs,
            queueMs,
            provider,
            baseLog,
            sourceProtocol: "openai" as const,
            streamProtocol: "openai" as const,
            responseProtocol: "openai" as const,
            releaseSlots: () => {
              releaseProv();
              releaseUser();
              releaseGlobal();
            },
          };
        } else {
          const response = await ai.models.generateContent(params);
          const mappedData = googleGenerateContentToOpenAI(response, modelId);
          const latencyMs = Date.now() - attemptStartProcessingMs;

          const msg = mappedData?.choices?.[0]?.message;
          if (msg) {
            if (adapter && adapter.transformNonStreamResponse) {
              adapter.transformNonStreamResponse(mappedData, adapterContext);
            }
          }
          let observation: any;
          if (adapter && adapter.observeNonStreamResponse) {
            try {
              observation = adapter.observeNonStreamResponse(JSON.parse(JSON.stringify(mappedData)), config.adapterState || {}, adapterContext);
            } catch (_) {}
          }

          const rawProviderUsage = detectProviderUsagePresence(mappedData);
          const roundOutputSnapshot = {
            completionText: extractCompletionText(mappedData),
            reasoningText: observation?.reasoningText || "",
            toolCallSerialization: mappedData.choices?.[0]?.message?.tool_calls ? JSON.stringify(mappedData.choices[0].message.tool_calls) : "",
          };
          const roundId = config.roundId || `round-${crypto.randomUUID().slice(0, 8)}`;

          if (incomingProtocol === "anthropic" && !isAnthropicUpstream) {
            const contentBlocks: any[] = [];
            if (msg?.content) {
              contentBlocks.push({ type: "text", text: msg.content });
            } else if (mappedData?.content && Array.isArray(mappedData.content)) {
              contentBlocks.push(...mappedData.content);
            }
            if (msg?.tool_calls && Array.isArray(msg.tool_calls)) {
              for (const tc of msg.tool_calls) {
                contentBlocks.push({
                  type: "tool_use",
                  id: tc.id,
                  name: tc.function?.name || "",
                  input: tc.function?.arguments
                    ? JSON.parse(tc.function.arguments)
                    : {},
                });
              }
            }
            if (contentBlocks.length === 0)
              contentBlocks.push({ type: "text", text: "" });

            let stopReason =
              mappedData.choices?.[0]?.finish_reason === "stop"
                ? "end_turn"
                : mappedData.choices?.[0]?.finish_reason === "length"
                  ? "max_tokens"
                  : "stop_sequence";
            if (mappedData.choices?.[0]?.finish_reason === "tool_calls") {
              stopReason = "tool_use";
            }

            const anthropicRes = {
              id: mappedData.id || `msg_${crypto.randomUUID()}`,
              type: "message",
              role: "assistant",
              model: modelId,
              content: contentBlocks,
              stop_reason: stopReason,
              stop_sequence: null,
              usage: {
                input_tokens: mappedData.usage?.prompt_tokens || 0,
                output_tokens: mappedData.usage?.completion_tokens || 0,
              },
            };
            return {
              status: 200,
              data: anthropicRes,
              isStream: false,
              sourceProtocol: "openai" as const,
              responseProtocol: "anthropic" as const,
              latencyMs,
              queueMs,
              provider,
              baseLog,
              rawProviderUsage,
              roundOutputSnapshot,
              roundId,
              observation,
            };
          }

          return {
            status: 200,
            data: mappedData,
            isStream: false,
            sourceProtocol: "openai" as const,
            responseProtocol: "openai" as const,
            latencyMs,
            queueMs,
            provider,
            baseLog,
            rawProviderUsage,
            roundOutputSnapshot,
            roundId,
            observation,
          };
        }
      };

      // Parse SDK error messages to extract HTTP status code and error details.
      // The SDK throws errors with JSON-stringified messages for API errors.
      const parseSdkError = (err: any): { status: number; data: any } | null => {
        const msg = String(err?.message || "");
        try {
          const parsed = JSON.parse(msg);
          if (parsed?.error?.code && typeof parsed.error.code === "number") {
            return { status: parsed.error.code, data: parsed };
          }
        } catch {
          // Try to find nested JSON in the error message
          const match = msg.match(/\{[\s\S]*"code"\s*:\s*(\d{3})[\s\S]*\}/);
          if (match) {
            const code = parseInt(match[1], 10);
            if (code >= 400 && code <= 599) {
              try {
                return { status: code, data: JSON.parse(match[0]) };
              } catch {
                return { status: code, data: { error: { message: msg, code } } };
              }
            }
          }
        }
        return null;
      };

      let result: UpstreamResponseData;
      try {
        if (provider.upstreamProxyUrl) {
          result = await fetchContextStorage.run(
            { upstreamProxyUrl: provider.upstreamProxyUrl },
            executeCall
          );
        } else {
          result = await executeCall();
        }
      } catch (sdkErr: any) {
        // Check if the SDK error contains a parseable API error response
        const parsed = parseSdkError(sdkErr);
        if (parsed) {
          clearTimeout(timeoutId);
          return {
            status: parsed.status,
            data: parsed.data,
            isStream: false,
            latencyMs: Date.now() - attemptStartProcessingMs,
            queueMs,
            provider,
            baseLog,
          };
        }
        // Not a parseable API error — re-throw for the outer catch
        throw sdkErr;
      }
      clearTimeout(timeoutId);
      return result;
    }

    let upstreamUrl = `${baseUrl}${upstreamPath}`;
    if (baseUrl.endsWith(upstreamPath)) {
      upstreamUrl = baseUrl;
    }

    let doFetch = fetch as any;
    let fetchOptions: any = {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(finalBody),
      signal: controller.signal as any,
    };

    if (provider.upstreamProxyUrl) {
      const { request } = await import("undici");
      const { Readable } = await import("stream");
      const dispatcher = await getProxyAgent(provider.upstreamProxyUrl);
      doFetch = async (url: string, options: any) => {
        const res = await request(url, {
          dispatcher,
          method: options.method || "GET",
          headers: options.headers,
          body: options.body,
          signal: options.signal,
        });

        const headersObj = new Headers();
        if (res.headers) {
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) {
              v.forEach((val) => headersObj.append(k, val));
            } else if (v) {
              headersObj.set(k, v);
            }
          }
        }

        // Convert undici BodyReadable (Node stream) to Web ReadableStream
        // so downstream code that calls .getReader() works correctly.
        const webStream = Readable.toWeb(res.body) as ReadableStream<Uint8Array>;

        return {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: "",
          headers: headersObj,
          json: async () => {
            const reader = webStream.getReader();
            const chunks: Uint8Array[] = [];
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            const text = new TextDecoder().decode(Buffer.concat(chunks.map(c => Buffer.from(c))));
            return JSON.parse(text);
          },
          text: async () => {
            const reader = webStream.getReader();
            const chunks: Uint8Array[] = [];
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            return new TextDecoder().decode(Buffer.concat(chunks.map(c => Buffer.from(c))));
          },
          body: webStream,
        };
      };
    }

    const response = await doFetch(upstreamUrl, fetchOptions);
    clearTimeout(timeoutId);

    const latencyMs = Date.now() - attemptStartProcessingMs;

    // ---- Non-OK response ----
    if (!response.ok) {
      const upstreamError = await readUpstreamError(response);
      return {
        status: response.status,
        statusText: response.statusText,
        data: upstreamError.data,
        errorDetail: upstreamError.detail,
        upstreamRequestIds: upstreamError.upstreamRequestIds,
        upstreamUrl,
        isStream: false,
        latencyMs,
        queueMs,
        provider,
        baseLog,
      };
    }

    // ---- Streaming path ----
    if (isStreaming) {
      const contentType = response.headers.get("content-type") || "";

      // Upstream returned JSON when we expected a stream.
      // Two cases:
      // 1. Error payload → return as non-stream error (let orchestrator handle fallback/logging)
      // 2. Success payload → wrap as fake SSE stream (provider returned complete response instead of stream)
      if (contentType.includes("application/json")) {
        const upstreamError = await readUpstreamError(response);
        const dataObj = upstreamError.data as any;

        const isErrorPayload =
          (dataObj &&
            (dataObj.error ||
              (dataObj.code && dataObj.code !== 0 && dataObj.code !== 200)));

        // Error payload: return as non-stream error, don't inject fake content
        if (isErrorPayload) {
          return {
            status: response.status >= 400 ? response.status : 502,
            statusText: response.statusText,
            data: upstreamError.data,
            errorDetail: upstreamError.detail,
            upstreamRequestIds: upstreamError.upstreamRequestIds,
            upstreamUrl,
            isStream: false,
            latencyMs,
            queueMs,
            provider,
            baseLog,
          };
        }

        // Success payload: provider returned a complete JSON response instead of a stream.
        // Run active translators on the data before wrapping it as a fake SSE stream.
        const msg = dataObj?.choices?.[0]?.message;
        if (msg) {
          if (adapter && adapter.transformNonStreamResponse) {
            adapter.transformNonStreamResponse(dataObj, adapterContext);
          }
        }
        if (adapter && adapter.observeNonStreamResponse) {
          try {
            adapter.observeNonStreamResponse(JSON.parse(JSON.stringify(dataObj)), config.adapterState || {}, adapterContext);
          } catch (_) {}
        }

        // Wrap the actual content (not an error message) as a fake SSE stream.
        const fakeStreamPolicy = adapter?.getRequestPolicy?.(adapterContext)?.preserveFakeStreamFields
          ? { preserveFields: adapter.getRequestPolicy!(adapterContext).preserveFakeStreamFields }
          : undefined;
        const upstreamResponseProtocol = (isAnthropicUpstream || dataObj?.type === "message" || (dataObj?.content && !dataObj?.choices)) ? "anthropic" : "openai";
        const { fakeStream, textToEmit } = createFakeStreamFromData(dataObj, modelId, upstreamResponseProtocol, fakeStreamPolicy);

        const releaseProv = holdProv();
        const releaseUser = holdUser();
        const releaseGlobal = holdGlobal();

        return {
          status: 200,
          data: dataObj,
          stream: fakeStream as any,
          isStream: true,
          isFakeStream: true,
          fakeStreamText: textToEmit,
          latencyMs,
          queueMs,
          provider,
          baseLog,
          sourceProtocol: (isAnthropicUpstream ? "anthropic" : "openai") as "openai" | "anthropic",
          streamProtocol: upstreamResponseProtocol,
          responseProtocol: upstreamResponseProtocol as "openai" | "anthropic",
          releaseSlots: () => {
            releaseProv();
            releaseUser();
            releaseGlobal();
          },
        };
      }

      // Normal streaming response
      const stream = isGoogleNativeUpstream
        ? googleNativeStreamToOpenAIStream(response.body as any, modelId)
        : response.body as any;
      const releaseProv = holdProv();
      const releaseUser = holdUser();
      const releaseGlobal = holdGlobal();
      return {
        status: response.status,
        stream,
        isStream: true,
        latencyMs,
        queueMs,
        provider,
        baseLog,
        sourceProtocol: (isAnthropicUpstream ? "anthropic" : "openai") as "openai" | "anthropic",
        streamProtocol: isAnthropicUpstream ? "anthropic" : "openai",
        responseProtocol: (isAnthropicUpstream ? "anthropic" : "openai") as "openai" | "anthropic",
        releaseSlots: () => {
          releaseProv();
          releaseUser();
          releaseGlobal();
        },
      };
    }

    let observation: any;

    // ---- Non-streaming path ----
    let data = await response.json();
    if (isGoogleNativeUpstream) {
      data = googleGenerateContentToOpenAI(data, modelId);
    }

    const rawProviderUsage = detectProviderUsagePresence(data);

    // Run active translators on the non-streaming data
    const msg = data?.choices?.[0]?.message;
    if (msg) {
      if (adapter && adapter.transformNonStreamResponse) {
        adapter.transformNonStreamResponse(data, adapterContext);
      }
    }
    if (adapter && adapter.observeNonStreamResponse) {
      try {
        observation = adapter.observeNonStreamResponse(JSON.parse(JSON.stringify(data)), config.adapterState || {}, adapterContext);
      } catch (_) {}
    }

    const roundOutputSnapshot = captureRoundOutputSnapshot(data, observation);

    // Anthropic-protocol conversion: translate OpenAI-style response into
    // Anthropic message format when the incoming protocol is anthropic but the
    // upstream is not.
    if (incomingProtocol === "anthropic" && !isAnthropicUpstream && !isStreaming) {
      const msg = data?.choices?.[0]?.message;
      const contentBlocks: any[] = [];
      if (msg?.content) {
        contentBlocks.push({ type: "text", text: msg.content });
      } else if (data?.content && Array.isArray(data.content)) {
        contentBlocks.push(...data.content);
      }
      if (msg?.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name || "",
            input: tc.function?.arguments
              ? JSON.parse(tc.function.arguments)
              : {},
          });
        }
      }
      if (contentBlocks.length === 0)
        contentBlocks.push({ type: "text", text: "" });

      let stopReason =
        data.choices?.[0]?.finish_reason === "stop"
          ? "end_turn"
          : data.choices?.[0]?.finish_reason === "length"
            ? "max_tokens"
            : "stop_sequence";
      if (data.choices?.[0]?.finish_reason === "tool_calls") {
        stopReason = "tool_use";
      }

      const anthropicRes = {
        id: data.id || `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model: modelId,
        content: contentBlocks,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: data.usage?.prompt_tokens || 0,
          output_tokens: data.usage?.completion_tokens || 0,
        },
      };
      return {
        status: response.status,
        data: anthropicRes,
        isStream: false,
        sourceProtocol: (isAnthropicUpstream ? "anthropic" : "openai") as "openai" | "anthropic",
        responseProtocol: "anthropic" as const,
        latencyMs,
        queueMs,
        provider,
        baseLog,
        observation,
        terminalError: config.adapterState?.terminalError,
        rawProviderUsage,
        roundOutputSnapshot,
        roundId,
      };
    }

    return {
      status: response.status,
      data,
      isStream: false,
      sourceProtocol: (isAnthropicUpstream ? "anthropic" : "openai") as "openai" | "anthropic",
      responseProtocol: (isAnthropicUpstream ? "anthropic" : "openai") as "openai" | "anthropic",
      latencyMs,
      queueMs,
      provider,
      baseLog,
      observation,
      terminalError: config.adapterState?.terminalError,
      rawProviderUsage,
      roundOutputSnapshot,
      roundId,
    };
  } catch (e: any) {
    clearTimeout(timeoutId);
    e.upstreamContext = {
      providerName: provider.name,
      providerId: provider.id,
      providerProtocol: currentAttempt.providerProtocol,
      modelId: currentAttempt.modelId,
      upstreamUrl: `${baseUrl}${upstreamPath}`,
      timeoutMs: provider.timeoutMs,
      queueMs,
      fallback: currentAttempt.isFallback,
      fallbackReason: currentAttempt.fallbackReason,
    };
    throw e;
  }
}

/**
 * Wraps a non-streaming JSON response object into a fake ReadableStream (SSE).
 */
export function createFakeStreamFromData(dataObj: any, modelId: string, effectiveProtocol?: string, fakeStreamPolicy?: { preserveFields?: string[], skipTextLength?: number, skipReasoningLength?: number }): { fakeStream: ReadableStream, textToEmit: string, isToolCalls: boolean } {
  if (effectiveProtocol === "anthropic") {
    // dataObj is in Anthropic format
    const contentBlocks = dataObj?.content || [];
    const isToolCalls = contentBlocks.some((c: any) => c.type === "tool_use");

    let reasoning = "";
    let mainContent = "";

    for (const block of contentBlocks) {
      if (block.type === "thinking" && block.thinking) {
        reasoning += block.thinking;
      } else if (block.type === "text" && block.text) {
        mainContent += block.text;
      }
    }

    const thinkMatch = mainContent.match(/^<think>([\s\S]*?)<\/think>\n?/);
    if (!reasoning && thinkMatch) {
      reasoning = thinkMatch[1];
      mainContent = mainContent.slice(thinkMatch[0].length);
    }

    if (fakeStreamPolicy?.skipReasoningLength) {
      reasoning = reasoning.slice(fakeStreamPolicy.skipReasoningLength);
    }
    if (fakeStreamPolicy?.skipTextLength) {
      mainContent = mainContent.slice(fakeStreamPolicy.skipTextLength);
    }

    const encoder = new TextEncoder();
    const chunks = [];
    const id = dataObj?.id || `msg_${crypto.randomUUID()}`;

    // message_start
    chunks.push(`event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: dataObj?.usage?.input_tokens || dataObj?.usage?.prompt_tokens || 0, output_tokens: 0 }
      }
    })}`);

    // If there is reasoning, emit a thinking block
    let contentBlockIndex = 0;

    for (const block of contentBlocks) {
      if (block.type === "thinking") {
        chunks.push(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: contentBlockIndex,
          content_block: { type: "thinking", thinking: "", signature: "" }
        })}`);

        if (block.thinking) {
          chunks.push(`event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "thinking_delta", thinking: block.thinking }
          })}`);
        }

        if (block.signature) {
          chunks.push(`event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "signature_delta", signature: block.signature }
          })}`);
        }

        chunks.push(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: contentBlockIndex
        })}`);
        contentBlockIndex++;
      } else if (block.type === "redacted_thinking") {
        chunks.push(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: contentBlockIndex,
          content_block: { type: "redacted_thinking", data: block.data }
        })}`);

        chunks.push(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: contentBlockIndex
        })}`);
        contentBlockIndex++;
      } else if (block.type === "tool_use") {
        chunks.push(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: contentBlockIndex,
          content_block: { type: "tool_use", id: block.id, name: block.name || "", input: {} }
        })}`);

        if (block.input && Object.keys(block.input).length > 0) {
          chunks.push(`event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
          })}`);
        }

        chunks.push(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: contentBlockIndex
        })}`);
        contentBlockIndex++;
      } else if (block.type === "text") {
        chunks.push(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: contentBlockIndex,
          content_block: { type: "text", text: "" }
        })}`);

        if (block.text) {
          chunks.push(`event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "text_delta", text: block.text }
          })}`);
        }

        chunks.push(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: contentBlockIndex
        })}`);
        contentBlockIndex++;
      }
    }

    // message_delta
    const stopReason = dataObj?.stop_reason || (isToolCalls ? "tool_use" : "end_turn");

    chunks.push(`event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: dataObj?.usage?.output_tokens || dataObj?.usage?.completion_tokens || 0 }
    })}`);

    // message_stop
    chunks.push(`event: message_stop\ndata: {"type":"message_stop"}`);

    const ssePayload = chunks.join("\n\n") + "\n\n";

    return {
      fakeStream: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(encoder.encode(ssePayload));
          ctrl.close();
        }
      }),
      textToEmit: mainContent,
      isToolCalls
    };
  }

  const message = dataObj?.choices?.[0]?.message;
  console.log("DEBUG createFakeStreamFromData: dataObj =", JSON.stringify(dataObj));
  const toolCalls = message?.tool_calls;
  const isToolCalls = !!(toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0);
  const textToEmit = typeof message?.content === "string" ? message.content : dataObj?.response || JSON.stringify(dataObj);


  let mainContent = "";
  const encoder = new TextEncoder();
  const id = `fake_${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const chunks = [];

  // Add reasoning fields if present
  let reasoning = typeof message?.reasoning === "string" ? message.reasoning : "";
  let reasoningDetails = message?.reasoning_details;
  let reasoningContent = typeof message?.reasoning_content === "string" ? message.reasoning_content : "";

  if (reasoningContent && fakeStreamPolicy?.skipReasoningLength) {
    reasoningContent = reasoningContent.slice(fakeStreamPolicy.skipReasoningLength);
  }
  if (reasoning && fakeStreamPolicy?.skipReasoningLength) {
    reasoning = reasoning.slice(fakeStreamPolicy.skipReasoningLength);
  }

  if (reasoningContent) {
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{
        index: 0,
        delta: { reasoning_content: reasoningContent },
        finish_reason: null
      }]
    });
  }

  if (reasoning && fakeStreamPolicy?.preserveFields?.includes('reasoning')) {
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{
        index: 0,
        delta: { reasoning },
        finish_reason: null
      }]
    });
  }
  if (reasoningDetails && fakeStreamPolicy?.preserveFields?.includes('reasoning_details')) {
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{
        index: 0,
        delta: { reasoning_details: reasoningDetails },
        finish_reason: null
      }]
    });
  }

  if (isToolCalls) {
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: toolCalls.map((tc: any, idx: number) => ({
              index: idx,
              id: tc.id,
              type: tc.type || "function",
              function: {
                name: tc.function?.name,
                arguments: tc.function?.arguments || ""
              }
            }))
          },
          logprobs: null,
          finish_reason: null
        }
      ]
    });
  } else {
    const textToEmit =
      typeof message?.content === "string"
        ? message.content
        : dataObj?.response || JSON.stringify(dataObj);

    mainContent = textToEmit;
    const thinkMatch = textToEmit.match(/^<think>([\s\S]*?)<\/think>\n?/);
    if (thinkMatch) {
      let thinkContent = thinkMatch[1];
      if (fakeStreamPolicy?.skipReasoningLength) {
        thinkContent = thinkContent.slice(fakeStreamPolicy.skipReasoningLength);
      }
      if (thinkContent) {
        chunks.push({
          id,
          object: "chat.completion.chunk",
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              delta: { reasoning_content: thinkContent },
              finish_reason: null,
            },
          ],
        });
      }
      mainContent = textToEmit.slice(thinkMatch[0].length);
    }

    if (fakeStreamPolicy?.skipTextLength) {
      mainContent = mainContent.slice(fakeStreamPolicy.skipTextLength);
    }

    if (mainContent || !chunks.length) {
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [
          {
            index: 0,
            delta: { content: mainContent },
            finish_reason: null,
          },
        ],
      });
    }
  }

    // Add final stop chunk
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: dataObj?.choices?.[0]?.finish_reason || (isToolCalls ? "tool_calls" : "stop"),
        },
      ]
    });

    if (dataObj.usage) {
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [],
        usage: dataObj.usage
      });
    }

    const ssePayload = chunks.map(c => `data: ${JSON.stringify(c)}`).join("\n\n") + "\n\ndata: [DONE]\n\n";

    const fakeStream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(encoder.encode(ssePayload));
        ctrl.close();
      },
    });

    return {
      fakeStream,
      textToEmit: isToolCalls ? "" : mainContent,
      isToolCalls
    };
}
