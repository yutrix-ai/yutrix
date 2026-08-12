/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                        ║
 * ║   CORE STREAM FORWARDING MODULE — PROTOCOL-COMPATIBLE PROXY           ║
 * ║                                                                        ║
 * ║   This module is the heart of PromptGate's proxy functionality.        ║
 * ║   It forwards upstream provider responses to downstream clients        ║
 * ║   with minimal protocol compatibility normalization when required.      ║
 * ║                                                                        ║
 * ║   ┌──────────────────────────────────────────────────────────────────┐  ║
 * ║   │  SACRED RULE: DO NOT MODIFY MESSAGE SEMANTICS                   │  ║
 * ║   │                                                                  │  ║
 * ║   │  Regardless of provider, protocol, or model, visible answer     │  ║
 * ║   │  content and tool calls MUST reach the client unchanged.        │  ║
 * ║   │                                                                  │  ║
 * ║   │  All processing (audit logging, reasoning extraction, think     │  ║
 * ║   │  tag parsing, token counting, cost calculation, etc.) is        │  ║
 * ║   │  EXTERNAL and operates on COPIES of the data through the       │  ║
 * ║   │  observer interface.                                            │  ║
 * ║   │                                                                  │  ║
 * ║   │  DO NOT add transformations unless fixing a genuine protocol    │  ║
 * ║   │  compatibility bug, such as provider thought metadata leaking   │  ║
 * ║   │  into visible content. If in doubt, DO NOT TOUCH.              │  ║
 * ║   └──────────────────────────────────────────────────────────────────┘  ║
 * ║                                                                        ║
 * ║   Legitimate transformations in this module are limited to protocol   ║
 * ║   envelope conversion (OpenAI SSE ↔ Anthropic SSE) and narrowly       ║
 * ║   scoped provider reasoning metadata normalization. Even then,        ║
 * ║   visible message CONTENT and tool calls must be preserved.           ║
 * ║                                                                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { FastifyReply } from "fastify";
import { activeTranslators } from "./translators";
import type { TranslatorState, TranslatorContext } from "./translators/types";
import crypto from "crypto";
import { parseSseDataLine } from "../../utils/gatewayContent";
import {
  formatStreamErrorEvent,
  formatStreamKeepAlive,
} from "./streamProtocol";

const KEEP_ALIVE_CHECK_MS = 1000;
const STREAM_IDLE_KEEP_ALIVE_MS = 5000;
const EARLY_IDLE_KEEP_ALIVE_MS = 2500;
const HIDDEN_PROGRESS_KEEP_ALIVE_MS = 2500;

import { mapErrorTypeToAnthropic } from "../../utils/gatewayError";

export function classifyUpstreamErrorWithAdapter(
  adapter: any,
  input: { rawError: any; statusCode?: number; phase: "http" | "nonstream" | "fake_stream" | "stream" },
  context: any
): any {
  if (adapter && typeof adapter.classifyUpstreamError === "function") {
    try {
      const res = adapter.classifyUpstreamError(input, context);
      if (res) return res;
    } catch (e) {
      console.error("[PromptGate] Adapter classifyUpstreamError failed:", e);
    }
  }

  let err = input.rawError || {};
  if (err.error) {
    err = err.error;
  }
  
  if (err.raw && typeof err.raw === "string") {
    let parsedRaw = null;
    const cleanRaw = err.raw.trim();
    if (cleanRaw.startsWith("data: ")) {
      try { parsedRaw = JSON.parse(cleanRaw.slice(6)); } catch (e) {}
    } else {
      try { parsedRaw = JSON.parse(cleanRaw); } catch (e) {}
    }
    if (parsedRaw && (parsedRaw.error || parsedRaw.message)) {
      err = parsedRaw.error || parsedRaw;
    }
  }

  let message = err?.message || (typeof err === "string" ? err : "Unknown gateway error");
  const errorType = err?.type || err?.errorType || err?.error_type || "upstream_error";
  const statusCode = input.statusCode || err?.status || err?.statusCode || 502;
  const rawCode = err?.code || "upstream_error";

  const fingerprintStr = `default|${statusCode}|${rawCode}|${errorType}|${message}`;
  const fingerprint = crypto.createHash("sha256").update(fingerprintStr).digest("hex").slice(0, 16);

  return {
    statusCode,
    code: String(rawCode),
    errorType,
    message,
    retryable: statusCode === 429 || statusCode === 503 || statusCode === 529,
    retryClass: statusCode === 429 ? "rate_limit" : (statusCode === 503 || statusCode === 529 ? "server_error" : "unknown"),
    adapterId: adapter?.id || "transparent",
    upstreamProvider: "Unknown",
    upstreamCode: String(rawCode),
    upstreamErrorType: errorType,
    safeMetadata: {},
    fingerprint,
    phase: input.phase,
  };
}

export function hasMeaningfulOutputEvent(chunk: string, protocol: string | undefined): boolean {
  if (!chunk) return false;

  const lines = chunk.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;

    const dataContent = trimmed.substring(5).trim();
    if (dataContent === "[DONE]") continue;

    try {
      const parsed = JSON.parse(dataContent);
      if (!parsed) continue;

      if (protocol === "anthropic") {
        if (parsed.type === "content_block_delta" && parsed.delta) {
          const delta = parsed.delta;
          if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
            return true;
          }
          if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
            return true;
          }
          if (delta.type === "input_json_delta" && delta.partial_json) {
            return true;
          }
        }
        if (parsed.type === "content_block_start" && parsed.content_block) {
          const block = parsed.content_block;
          if (block.type === "text" && block.text && block.text.length > 0) {
            return true;
          }
          if (block.type === "thinking" && block.thinking && block.thinking.length > 0) {
            return true;
          }
          if (block.type === "tool_use") {
            return true;
          }
        }
      } else {
        if (parsed.choices && Array.isArray(parsed.choices)) {
          for (const choice of parsed.choices) {
            const delta = choice.delta;
            if (!delta) continue;

            if (typeof delta.content === "string" && delta.content.length > 0) {
              return true;
            }
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
              return true;
            }
            if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
              return true;
            }
            if (delta.tool_calls && Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
              return true;
            }
          }
        }
      }
    } catch {
      // Non-JSON or corrupt payload
    }
  }

  return false;
}

/** Visible answer/tool payload only — reasoning/thought does not count (OpenCode ignores it). */
export function hasVisibleAnswerEvent(chunk: string, protocol: string | undefined): boolean {
  if (!chunk) return false;

  const lines = chunk.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;

    const dataContent = trimmed.substring(5).trim();
    if (dataContent === "[DONE]") continue;

    try {
      const parsed = JSON.parse(dataContent);
      if (!parsed) continue;

      if (protocol === "anthropic") {
        if (parsed.type === "content_block_delta" && parsed.delta) {
          const delta = parsed.delta;
          if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
            return true;
          }
          if (delta.type === "input_json_delta" && delta.partial_json) {
            return true;
          }
        }
        if (parsed.type === "content_block_start" && parsed.content_block) {
          const block = parsed.content_block;
          if (block.type === "text" && block.text && block.text.length > 0) {
            return true;
          }
          if (block.type === "tool_use") {
            return true;
          }
        }
      } else if (parsed.choices && Array.isArray(parsed.choices)) {
        for (const choice of parsed.choices) {
          const delta = choice.delta;
          if (!delta) continue;
          if (typeof delta.content === "string" && delta.content.length > 0) {
            return true;
          }
          if (delta.tool_calls && Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
            return true;
          }
        }
      }
    } catch {
      // Non-JSON or corrupt payload
    }
  }

  return false;
}

function createDownstreamWriter(
  reply: FastifyReply,
  protocol: string | undefined,
  getIdleKeepAliveMs: () => number,
  disableKeepAlive: boolean = false
) {
  let lastWriteTime = Date.now();
  let writeError: Error | undefined;
  let pingInterval: NodeJS.Timeout | undefined;

  const isWritable = () => !reply.raw.destroyed && !reply.raw.writableEnded;
  const rememberError = (err: unknown) => {
    writeError = err instanceof Error ? err : new Error(String(err));
  };

  const write = (payload: string): boolean => {
    if (writeError) throw writeError;
    if (!isWritable()) {
      throw new Error("Downstream connection closed");
    }
    try {
      reply.raw.write(payload);
      lastWriteTime = Date.now();
      return true;
    } catch (err) {
      rememberError(err);
      throw writeError;
    }
  };

  const pingIfIdle = (minIdleMs = getIdleKeepAliveMs()): boolean => {
    if (writeError || !isWritable()) return false;
    if (Date.now() - lastWriteTime < minIdleMs) return false;
    try {
      reply.raw.write(formatStreamKeepAlive(protocol));
      lastWriteTime = Date.now();
      return true;
    } catch (err) {
      rememberError(err);
      if (pingInterval) clearInterval(pingInterval);
      return false;
    }
  };

  if (!disableKeepAlive) {
    pingInterval = setInterval(() => {
      pingIfIdle(getIdleKeepAliveMs());
    }, KEEP_ALIVE_CHECK_MS);
  }

  return {
    write,
    pingIfIdle,
    stop: () => {
      if (pingInterval) clearInterval(pingInterval);
    },
    throwIfFailed: () => {
      if (writeError) throw writeError;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Observer Interface — for EXTERNAL processing on data COPIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Observer receives deep copies of parsed SSE data for external processing.
 *
 * Observers MUST NOT affect the forwarding pipeline in any way.
 * They exist solely for audit logging, token counting, progress tracking, etc.
 */
export interface StreamForwardObserver {
  /** Called with a deep copy of each parsed SSE data object. */
  onParsedChunk(dataCopy: any): void;
  /** Called when the first chunk arrives from upstream. */
  onFirstChunk?(): void;
  /** Called when the upstream stream reading is complete. */
  onStreamEnd?(): void;
  /** Optionally retrieve the accumulated completion tokens. */
  getCompletionTokens?(): number;
  /** Mutable accumulated reasoning text, set directly by forwarder for adapter-extracted reasoning. */
  accumulatedReasoningText?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Protocol Adaptation Config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for cross-protocol stream adaptation.
 *
 * When the client protocol differs from the upstream protocol,
 * the SSE envelope format must be converted. This is the ONLY
 * legitimate transformation — all message CONTENT is preserved verbatim.
 */
export interface ProtocolAdaptationConfig {
  /** The protocol the client expects. */
  targetProtocol: "anthropic";
  /** A unique message ID for the Anthropic response envelope. */
  messageId: string;
  /** The model ID to report in the Anthropic message envelope. */
  modelId: string;
  /** The prompt token count for the Anthropic message envelope. */
  promptTokens: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Transparent SSE Forwarding (Same Protocol)
// ─────────────────────────────────────────────────────────────────────────────

export interface TransparentForwardResult {
  /** Whether any chunks were received from upstream. */
  gotFirstChunk: boolean;
  /** Optional sentinel for graceful cutoff closing. */
  closingSentinel?: string;
  /** True when the forwarder already wrote an error or terminal SSE event. */
  terminalEventSent?: boolean;
  /** The terminal error if the stream ended with one. */
  terminalError?: any;
  /** True if actual content, reasoning, or tool calls have been sent downstream */
  meaningfulClientOutputSent: boolean;
  /** True if visible answer text or tool calls were sent (excludes reasoning-only). */
  visibleClientOutputSent?: boolean;
}

/**
 * Forward an upstream SSE stream to the client transparently, except for
 * narrow provider compatibility fixes such as Google thought metadata.
 *
 * Raw SSE lines are forwarded byte-for-byte unless a narrowly scoped
 * compatibility translator normalizes provider-specific reasoning metadata.
 * The observer receives parsed data after that normalization for external
 * processing.
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  SACRED: This function must not modify visible answer semantics.
 *  Only provider-specific reasoning/thought metadata may be normalized
 *  into protocol-standard fields.
 * ═══════════════════════════════════════════════════════════════════════
 */
export interface StreamTerminalReplayState {
  usageForwarded: boolean;
  usageSuppressed: boolean;
  doneForwarded: boolean;
  terminalChoiceForwarded: boolean;
  suppressedUsageChunkBytes?: string;
}

export interface StitchState {
  isStitching: boolean;
  insideToolCall: boolean;
  toolCallIndex: number;
  toolCallId: string;
  toolCallName: string;
  isLastCycle?: boolean;
  terminalReplayState?: StreamTerminalReplayState;
}

export async function forwardSSEStreamTransparent(
  reply: FastifyReply,
  upstream: ReadableStream | any,
  observer?: StreamForwardObserver,
  stitchState?: StitchState,
  streamTimeoutMs?: number,
  incomingProtocol?: string,
  context?: TranslatorContext,
  adapter?: any,
  adapterState?: any,
  adapterContext?: any,
  logAction?: any,
  baseActionLog?: any,
  sourceProtocol?: string,
): Promise<TransparentForwardResult & { isLengthTruncated?: boolean, lastToolCallState?: StitchState }> {
  if (!stitchState) {
    stitchState = {
      isStitching: false,
      insideToolCall: false,
      toolCallIndex: 0,
      toolCallId: "",
      toolCallName: "",
      terminalReplayState: { usageForwarded: false, usageSuppressed: false, doneForwarded: false, terminalChoiceForwarded: false }
    };
  } else if (!stitchState.terminalReplayState) {
    stitchState.terminalReplayState = { usageForwarded: false, usageSuppressed: false, doneForwarded: false, terminalChoiceForwarded: false };
  }
  const reader = (upstream as any).getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let gotFirstChunk = false;
  let streamTimeoutId: NodeJS.Timeout | undefined;
  const translatorState: TranslatorState = {};
  let hadLengthCutoff = false;
  let meaningfulClientOutputSent = false;
  let visibleClientOutputSent = false;
  let streamHadDoneEvent = false;
  let pendingUsageEvents: string[] = [];

  const isTransparentNoStitch = (!stitchState?.isStitching && incomingProtocol === (sourceProtocol || "openai") && (!adapter || adapter.id === "transparent"));

  const downstream = createDownstreamWriter(
    reply,
    incomingProtocol,
    () => gotFirstChunk ? STREAM_IDLE_KEEP_ALIVE_MS : EARLY_IDLE_KEEP_ALIVE_MS,
    isTransparentNoStitch
  );

  const originalWrite = downstream.write.bind(downstream);
  downstream.write = (chunk: string) => {
    const success = originalWrite(chunk);
    if (success && chunk) {
      if (hasMeaningfulOutputEvent(chunk, incomingProtocol)) {
        meaningfulClientOutputSent = true;
      }
      if (hasVisibleAnswerEvent(chunk, incomingProtocol)) {
        visibleClientOutputSent = true;
      }
    }
    return success;
  };

  try {
  while (true) {
    let racePromise: any = reader.read();
    if (streamTimeoutMs && streamTimeoutMs > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        streamTimeoutId = setTimeout(() => reject(new Error("Stream chunk timeout")), streamTimeoutMs);
      });
      racePromise = Promise.race([racePromise, timeoutPromise]);
    }
    const { done, value } = await racePromise;
    if (streamTimeoutId) { clearTimeout(streamTimeoutId); streamTimeoutId = undefined; }
    downstream.throwIfFailed();

    if (value) {
      if (!gotFirstChunk) {
        gotFirstChunk = true;
        observer?.onFirstChunk?.();
      }
      const chunkStr = decoder.decode(value, { stream: true });
      buffer += chunkStr;
      
    }

    if (done) {
      // Decode any remaining bytes
      buffer += decoder.decode(new Uint8Array(0));
    }

    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      let eventStr = "";

      if (match) {
        const matchedLength = match.index! + match[0].length;
        eventStr = buffer.slice(0, matchedLength);
        buffer = buffer.slice(matchedLength);
      } else if (done && buffer.length > 0) {
        eventStr = buffer;
        buffer = "";
      } else {
        break; // Need more data for a complete event
      }

      let modifiedEventStr = "";
      let hasTerminalError = false;
      let isLengthCutoff = false;
      let shouldSkipWrite = false;
      let eventHasUsage = false;
      let eventHasChoices = false;
      let eventHasSemanticContent = false;
      let eventIsDone = false;
      let eventChunkFinishReason: string | null = null;
      let originalEventStr = "";
      let skippedDoneLine = false;

      const lineRegex = /([^\r\n]*)(\r?\n)?/g;
      let lineMatch;
      while ((lineMatch = lineRegex.exec(eventStr)) !== null) {
        if (lineMatch[0] === "") break;
        const rawLine = lineMatch[1];
        const ending = lineMatch[2] || "";
        const trimmedLine = rawLine.trim();
        let outputLine = rawLine;
        originalEventStr += rawLine + ending;

        if (trimmedLine === "") {
          modifiedEventStr += ending;
          continue;
        }

        const dataText = parseSseDataLine(trimmedLine);
        const isTransparentNoStitch = (!stitchState?.isStitching && incomingProtocol === sourceProtocol && (!adapter || adapter.id === "transparent"));

        let skipThisLine = false;

        if (dataText === "[DONE]") {
          eventIsDone = true;
          if (!isTransparentNoStitch || hadLengthCutoff) {
            skipThisLine = true;
            skippedDoneLine = true;
          }
        }
        if (dataText && dataText !== "[DONE]") {
          let dataCopy: any;
          try {
            dataCopy = JSON.parse(dataText);
          } catch {
            // Unparseable data line — ignore
          }

             if (dataCopy) {
             let chunkHasUsage = false;
             if (dataCopy.usage && dataCopy.type !== "message_delta") {
               eventHasUsage = true;
             }
            if (dataCopy.choices && dataCopy.choices.length > 0) {
              eventHasChoices = true;
              const delta = dataCopy.choices[0].delta;
              if (delta) {
                if (delta.content && delta.content.length > 0) {
                  eventHasSemanticContent = true;
                  visibleClientOutputSent = true;
                }
                if (delta.reasoning_content && delta.reasoning_content.length > 0) eventHasSemanticContent = true;
                if (delta.tool_calls && delta.tool_calls.length > 0) {
                  for (const tc of delta.tool_calls) {
                    if (tc.function && (tc.function.name || tc.function.arguments)) {
                      eventHasSemanticContent = true;
                      visibleClientOutputSent = true;
                    }
                  }
                }
              }
            }
            if (dataCopy?.choices?.[0]?.finish_reason) {
              eventChunkFinishReason = dataCopy.choices[0].finish_reason;
            }
            if (dataCopy?.choices?.[0]?.finish_reason === "length") {
              isLengthCutoff = true;
            } else if (dataCopy?.type === "message_delta" && dataCopy?.delta?.stop_reason === "max_tokens" && sourceProtocol === "anthropic") {
              logAction?.({
                ...(baseActionLog || {}),
                level: "INFO",
                code: "request.continuity.native_anthropic_not_retried",
                message: "Native Anthropic max_tokens encountered but not retried",
              });
            }
            // Track tool calls for state
            const tcs = dataCopy?.choices?.[0]?.delta?.tool_calls;
            if (tcs && tcs.length > 0) {
              stitchState.insideToolCall = true;
              stitchState.toolCallIndex = tcs[0].index !== undefined ? tcs[0].index : stitchState.toolCallIndex;
              if (tcs[0].id) stitchState.toolCallId = tcs[0].id;
              if (tcs[0].function?.name) stitchState.toolCallName = tcs[0].function.name;
            }

            if (stitchState.isStitching && stitchState.insideToolCall) {
              const contentDelta = dataCopy?.choices?.[0]?.delta?.content;
              if (contentDelta) {
                 dataCopy.choices[0].delta = {
                   tool_calls: [{
                     index: stitchState.toolCallIndex,
                     function: { arguments: contentDelta }
                   }]
                 };
                 outputLine = `data: ${JSON.stringify(dataCopy)}`;
              }
            }

            if (!stitchState.isStitching) {
              let translated = false;
              if (adapter && adapter.transformStreamChunk) {
                translated = adapter.transformStreamChunk(dataCopy, adapterState || {}, adapterContext || context) || translated;
              }
              if (translated) {
                outputLine = `data: ${JSON.stringify(dataCopy)}`;
              }
            }

            // Make a deep copy for observation
            const chunkCopyForObs = JSON.parse(JSON.stringify(dataCopy));
            if (adapter && adapter.observeStreamChunk) {
              try {
                const observation = adapter.observeStreamChunk(chunkCopyForObs, adapterState || {}, adapterContext || context);

                if (observation?.reasoningText && observer && !isLengthCutoff) {
                  const delta = dataCopy.choices?.[0]?.delta || dataCopy.choices?.[0]?.message;
                  const hasReasoningContent = delta?.reasoning_content !== undefined;
                  if (hasReasoningContent) {
                    const rcText = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
                    const extra = observation.reasoningText.replace(rcText, "");
                    if (extra) observer.accumulatedReasoningText += extra;
                  } else {
                    observer.accumulatedReasoningText += observation.reasoningText;
                  }
                }

                if (adapterState?.terminalError) {
                  hasTerminalError = true;
                  if (logAction) {
                    const isTransient = !meaningfulClientOutputSent;
                    logAction({
                      ...(baseActionLog || {}),
                      level: isTransient ? "WARN" : "ERROR",
                      code: isTransient ? "request.transient_terminal_error" : "request.provider_adapter.stream_error",
                      providerName: baseActionLog?.providerName,
                      modelId: baseActionLog?.model,
                      adapterId: adapter.id,
                      statusCode: adapterState.terminalError.statusCode,
                      errorCode: adapterState.terminalError.code,
                      errorType: adapterState.terminalError.errorType,
                      retryClass: adapterState.terminalError.retryClass,
                      upstreamProvider: adapterState.terminalError.upstreamProvider,
                      upstreamCode: adapterState.terminalError.upstreamCode,
                      upstreamErrorType: adapterState.terminalError.upstreamErrorType,
                      fingerprint: adapterState.terminalError.fingerprint,
                      safeMetadata: adapterState.terminalError.safeMetadata ? JSON.stringify(adapterState.terminalError.safeMetadata) : undefined,
                      phase: "stream",
                      message: `Stream error: ${adapterState.terminalError.message}`,
                    });
                  }
                }
              } catch (obsErr: any) {
                if (logAction) {
                  logAction({
                    ...(baseActionLog || {}),
                    level: "WARN",
                    code: "request.provider_adapter.observer_error",
                    adapterId: adapter.id,
                    message: `Observer error: ${obsErr.message || String(obsErr)}`,
                  });
                }
              }
            }

             if (observer) {
               observer.onParsedChunk(dataCopy);
             }

             if (isLengthCutoff && eventHasSemanticContent) {
               delete dataCopy.usage;
               if (dataCopy.choices?.[0]) dataCopy.choices[0].finish_reason = null;
               outputLine = `data: ${JSON.stringify(dataCopy)}`;
               // In this case we ARE stitching because we stripped length.
             }
          }
        }

        if (!shouldSkipWrite && !skipThisLine) {
          modifiedEventStr += outputLine + ending;
        }
      }

      if (hasTerminalError) {
        // Delay sending terminal event if we might retry
        const err = adapterState?.terminalError;
        let sentEvent = false;

        // If we haven't sent content yet, we don't emit the error downstream, we just cancel.
        // It'll be handled/retried by the Orchestrator.
        if (!meaningfulClientOutputSent) {
          // Do not write anything yet.
        } else {
          downstream.write(eventStr);
          sentEvent = true;
        }

        await reader.cancel().catch(() => {});
        observer?.onStreamEnd?.();
        return { gotFirstChunk, isLengthTruncated: false, lastToolCallState: stitchState, terminalEventSent: sentEvent, terminalError: adapterState?.terminalError, meaningfulClientOutputSent, visibleClientOutputSent };
      }

      // already determined before while loop
      // const isTransparentNoStitch = (!stitchState?.isStitching && incomingProtocol === sourceProtocol && (!adapter || adapter.id === "transparent"));

      if (isLengthCutoff) {
         hadLengthCutoff = true;
         pendingUsageEvents = []; // drop any usage we were holding
         if (!eventHasSemanticContent) {
           // Skip write completely if it has no content
           shouldSkipWrite = true;
         }
      }

      if (hadLengthCutoff) {
         // Drop everything if it's DONE or usage only
         if (eventIsDone || (eventHasUsage && !eventHasSemanticContent && !eventChunkFinishReason)) {
           shouldSkipWrite = true;
         }
      } else if (eventHasUsage && !eventHasSemanticContent && !eventChunkFinishReason) {
         // Hold usage-only events until we know if it's a length cutoff
         pendingUsageEvents.push(originalEventStr);
         shouldSkipWrite = true;
      } else {
         // We are writing a regular event (content or stop or DONE)
         if (!shouldSkipWrite && !hadLengthCutoff) {
           // First flush any pending usage events
           if (isTransparentNoStitch) {
             for (const ev of pendingUsageEvents) {
               downstream.write(ev);
             }
           } else {
             // Not completely transparent, so write the modified versions? 
             // Actually, the original modified ones for usage are lost. 
             // But usage is stripped if stitching anyway.
             for (const ev of pendingUsageEvents) {
               downstream.write(ev);
             }
           }
           if (pendingUsageEvents.length > 0) {
             stitchState!.terminalReplayState!.usageForwarded = true;
           }
           pendingUsageEvents = [];

           if (eventIsDone && !skippedDoneLine) {
             stitchState!.terminalReplayState!.doneForwarded = true;
           }
         }
      }

      if (!shouldSkipWrite && modifiedEventStr) {
         // Strict byte equality for completely transparent mode without cutoff
         if (isTransparentNoStitch && !hadLengthCutoff) {
           downstream.write(originalEventStr);
           if (eventHasUsage) stitchState!.terminalReplayState!.usageForwarded = true;
         } else {
           downstream.write(modifiedEventStr);
           if (eventHasUsage) stitchState!.terminalReplayState!.usageForwarded = true;
         }
      }
    }

        if (done) {
      // Flush any pending usage events that were held waiting for a potential length cutoff
      if (!hadLengthCutoff && pendingUsageEvents.length > 0) {
        for (const ev of pendingUsageEvents) {
          if (isTransparentNoStitch) {
            downstream.write(ev);
          } else {
            downstream.write(ev);
          }
        }
        if (stitchState?.terminalReplayState) {
          stitchState.terminalReplayState.usageForwarded = true;
        }
        pendingUsageEvents = [];
      }
      break;
    }
  }
  } catch (err: any) {
    if (streamTimeoutId) clearTimeout(streamTimeoutId);

    const isTimeout = err.message === "Stream chunk timeout";
    const statusCode = isTimeout ? 504 : 502;
    const classified = classifyUpstreamErrorWithAdapter(
      adapter,
      {
        rawError: err,
        statusCode,
        phase: "stream",
      },
      adapterContext
    );

    if (adapterState) {
      adapterState.terminalError = classified;
    }

    await reader.cancel().catch(() => {});

    if (logAction && baseActionLog) {
      logAction({
        ...baseActionLog,
        level: "ERROR",
        code: "request.provider_adapter.stream_error",
        adapterId: adapter?.id || "transparent",
        errorCode: classified.code,
        errorType: classified.errorType,
        message: `Stream exception: ${classified.message}`,
      });
    }

    let sentEvent = false;
    if (meaningfulClientOutputSent) {
      downstream.write(formatStreamErrorEvent(incomingProtocol, statusCode, classified.message));
      sentEvent = true;
    } else {
      // transient/early stream error - don't emit downstream so orchestrator can retry
    }

    observer?.onStreamEnd?.();
    return { gotFirstChunk, isLengthTruncated: false, lastToolCallState: stitchState, terminalEventSent: sentEvent, terminalError: classified, meaningfulClientOutputSent, visibleClientOutputSent };
  } finally {
    downstream.stop();
  }

  observer?.onStreamEnd?.();

  return { gotFirstChunk, isLengthTruncated: hadLengthCutoff, lastToolCallState: stitchState, meaningfulClientOutputSent, visibleClientOutputSent };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Adapted SSE Forwarding (Cross-Protocol: OpenAI upstream → Anthropic client)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forward an upstream OpenAI-format SSE stream to an Anthropic-format client.
 *
 * This function converts the SSE ENVELOPE format from OpenAI to Anthropic.
 * Visible message content and tool calls are preserved while the transport
 * format changes. Provider-specific reasoning markers may be normalized into
 * reasoning_content before Anthropic envelope conversion.
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  CONTENT INTEGRITY: Visible content fields from upstream are preserved.
 *  - delta.content       → Anthropic text_delta
 *  - delta.tool_calls    → Anthropic tool_use blocks (verbatim)
 *  - reasoning_content   → Silently accumulated (no Anthropic equivalent
 *                          without extended thinking mode; the observer
 *                          captures it for audit purposes)
 * ═══════════════════════════════════════════════════════════════════════
 */
export async function forwardSSEStreamAdapted(
  reply: FastifyReply,
  upstream: ReadableStream | any,
  adaptation: ProtocolAdaptationConfig,
  observer?: StreamForwardObserver,
  stitchState?: StitchState,
  streamTimeoutMs?: number,
  context?: TranslatorContext,
  adapter?: any,
  adapterState?: any,
  adapterContext?: any,
  logAction?: any,
  baseActionLog?: any,
  anthropicState?: any
): Promise<TransparentForwardResult & { isLengthTruncated?: boolean, terminalEventSent?: boolean, anthropicState?: any }> {
  const reader = (upstream as any).getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let gotFirstChunk = false;
  let streamTimeoutId: NodeJS.Timeout | undefined;
  let shouldSkipWrite = false;
  let meaningfulClientOutputSent = false;
  const downstream = createDownstreamWriter(
    reply,
    "anthropic",
    () => gotFirstChunk ? STREAM_IDLE_KEEP_ALIVE_MS : EARLY_IDLE_KEEP_ALIVE_MS,
  );
  const originalWrite = downstream.write.bind(downstream);
  downstream.write = (payload: string): boolean => {
    if (shouldSkipWrite) return true;
    const success = originalWrite(payload);
    if (success && payload) {
      if (hasMeaningfulOutputEvent(payload, "anthropic")) {
        meaningfulClientOutputSent = true;
      }
    }
    return success;
  };

  const translatorState: TranslatorState = {};

  // Anthropic envelope state
  let anthropicBlockIndex = anthropicState ? anthropicState.activeBlockIndex : 0;
  let isInsideTextBlock = anthropicState ? anthropicState.isInsideTextBlock : false;
  let activeToolCalls = anthropicState ? anthropicState.activeToolCalls : {} as Record<number, {
    id: string;
    name: string;
    emittedStart: boolean;
    closed: boolean;
  }>;

  let hadLengthCutoff = false;
  let closingSentinel = "";
  let closingSentinelEmitted = false;
  const hasPreludeMessageStart = (reply.raw as any).__promptgateAnthropicMessageStarted === true;

  // Emit Anthropic message_start envelope only if not stitching and the early
  // stream prelude did not already open the Anthropic message.
  if (!stitchState?.isStitching && !hasPreludeMessageStart) {
    downstream.write(`event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: adaptation.messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: adaptation.modelId,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: adaptation.promptTokens,
          output_tokens: 0,
        },
      },
    })}\n\n`);
    (reply.raw as any).__promptgateAnthropicMessageStarted = true;
  } else {
    // If we are stitching, we are already inside a message.
    // We just start pushing content blocks, but we shouldn't emit a new message_start.
    // NOTE: For simplicity, the adapted format continues forwarding content_block_delta
    // directly. We must also suppress the next content_block_start if it's purely text continuation.
    // Let's set anthropicBlockIndex to a non-zero value or just assume it's text continuation.
  }

  try {
  while (true) {
    let racePromise: any = reader.read();
    if (streamTimeoutMs && streamTimeoutMs > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        streamTimeoutId = setTimeout(() => reject(new Error("Stream chunk timeout")), streamTimeoutMs);
      });
      racePromise = Promise.race([racePromise, timeoutPromise]);
    }
    const { done, value } = await racePromise;
    if (streamTimeoutId) { clearTimeout(streamTimeoutId); streamTimeoutId = undefined; }
    downstream.throwIfFailed();
    if (done) break;

    if (!gotFirstChunk) {
      gotFirstChunk = true;
      observer?.onFirstChunk?.();
    }

    const chunkStr = decoder.decode(value, { stream: true });
    buffer += chunkStr;

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const rawLine = buffer.slice(0, newlineIndex);
      const line = rawLine.trim();
      buffer = buffer.slice(newlineIndex + 1);

      const dataText = parseSseDataLine(line);
      if (dataText && dataText !== "[DONE]") {
        try {
          const data = JSON.parse(dataText);
          let isLengthCutoff = false;
          let shouldSkipWriteInside = hadLengthCutoff;
          let wroteDownstream = false;

          if (data.choices?.[0]?.finish_reason === "length") {
            isLengthCutoff = true;
            hadLengthCutoff = true;
            shouldSkipWriteInside = true;
            shouldSkipWrite = true;
          }

          // Run active translators
          if (adapter) {
            if (adapter.transformStreamChunk) {
              adapter.transformStreamChunk(data, adapterState || {}, adapterContext || context);
            }
          }

          // Make a deep copy for observation
          const chunkCopyForObs = JSON.parse(JSON.stringify(data));
          if (adapter && adapter.observeStreamChunk) {
            try {
              const observation = adapter.observeStreamChunk(chunkCopyForObs, adapterState || {}, adapterContext || context);

              // Feed adapter-extracted reasoning to observer (same dedup as transparent path)
              if (observation?.reasoningText && observer && !isLengthCutoff) {
                const delta = data.choices?.[0]?.delta || data.choices?.[0]?.message;
                const hasReasoningContent = delta?.reasoning_content !== undefined;
                if (hasReasoningContent) {
                  const rcText = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
                  const extra = observation.reasoningText.replace(rcText, "");
                  if (extra) {
                    observer.accumulatedReasoningText += extra;
                  }
                } else {
                  observer.accumulatedReasoningText += observation.reasoningText;
                }
              }

              if (adapterState?.terminalError) {
                if (logAction) {
                  const isTransient = !meaningfulClientOutputSent;
                  logAction({
                    ...(baseActionLog || {}),
                    level: isTransient ? "WARN" : "ERROR",
                    code: isTransient ? "request.transient_terminal_error" : "request.provider_adapter.stream_error",
                    providerName: baseActionLog?.providerName,
                    modelId: baseActionLog?.model,
                    adapterId: adapter.id,
                    statusCode: adapterState.terminalError.statusCode,
                    errorCode: adapterState.terminalError.code,
                    errorType: adapterState.terminalError.errorType,
                    retryClass: adapterState.terminalError.retryClass,
                    upstreamProvider: adapterState.terminalError.upstreamProvider,
                    upstreamCode: adapterState.terminalError.upstreamCode,
                    upstreamErrorType: adapterState.terminalError.upstreamErrorType,
                    fingerprint: adapterState.terminalError.fingerprint,
                    safeMetadata: adapterState.terminalError.safeMetadata ? JSON.stringify(adapterState.terminalError.safeMetadata) : undefined,
                    phase: "stream",
                    message: `Stream error: ${adapterState.terminalError.message}`,
                  });
                }
              }
            } catch (obsErr: any) {
              if (logAction) {
                logAction({
                  ...(baseActionLog || {}),
                  level: "WARN",
                  code: "request.provider_adapter.observer_error",
                  adapterId: adapter.id,
                  message: `Observer error: ${obsErr.message || String(obsErr)}`,
                });
              }
            }
          }

          if (adapterState?.terminalError) {
            const err = adapterState.terminalError;

            let sentEvent = false;

            if (!meaningfulClientOutputSent) {
              // skip writing terminal event, delegate to orchestrator
            } else {
              // Map canonical errorType to Anthropic error.type
              const anthropicType = mapErrorTypeToAnthropic(err.errorType);
              downstream.write(formatStreamErrorEvent(
                "anthropic",
                err.statusCode,
                err.message || "Upstream terminal error",
                { type: anthropicType, canonicalErrorType: err.errorType }
              ));
              sentEvent = true;
            }

            await reader.cancel().catch(() => {});
            observer?.onStreamEnd?.();
            return { gotFirstChunk, isLengthTruncated: false, terminalEventSent: sentEvent, terminalError: err, meaningfulClientOutputSent };
          }

          // Notify observer with a deep COPY
          if (observer) {
            observer.onParsedChunk(JSON.parse(JSON.stringify(data)));
          }

          // ─── Content text deltas → Anthropic text_delta ───
          // Visible content is forwarded after protocol compatibility
          // translators have moved hidden reasoning into reasoning_content.
          let deltaText = "";
          if (data.choices?.[0]?.delta?.content) {
            deltaText = data.choices[0].delta.content;
          } else if (data.choices?.[0]?.message?.content) {
            deltaText = data.choices[0].message.content;
          }

          if (deltaText) {
            if (!isInsideTextBlock && Object.keys(activeToolCalls).length === 0) {
              wroteDownstream = downstream.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: anthropicBlockIndex,
                content_block: { type: "text", text: "" },
              })}\n\n`) || wroteDownstream;
              isInsideTextBlock = true;
            }
            wroteDownstream = downstream.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: anthropicBlockIndex,
              delta: { type: "text_delta", text: deltaText },
            })}\n\n`) || wroteDownstream;
            meaningfulClientOutputSent = true;
          }

          // ─── Tool call deltas → Anthropic tool_use blocks ───
          const toolCallsDelta = data.choices?.[0]?.delta?.tool_calls;
          if (toolCallsDelta && Array.isArray(toolCallsDelta)) {
            for (const tc of toolCallsDelta) {
              if (!activeToolCalls[tc.index]) {
                // Close text block if open
                if (isInsideTextBlock) {
                  wroteDownstream = downstream.write(`event: content_block_stop\ndata: ${JSON.stringify({
                    type: "content_block_stop",
                    index: anthropicBlockIndex,
                  })}\n\n`) || wroteDownstream;
                  isInsideTextBlock = false;
                  anthropicBlockIndex++;
                }

                // Close previous tool calls
                for (const prevIndexStr in activeToolCalls) {
                  const prevIndex = parseInt(prevIndexStr);
                  if (prevIndex < tc.index) {
                    const prevTool = activeToolCalls[prevIndex];
                    if (!prevTool.closed && prevTool.emittedStart) {
                      wroteDownstream = downstream.write(`event: content_block_stop\ndata: ${JSON.stringify({
                        type: "content_block_stop",
                        index: anthropicBlockIndex + prevIndex,
                      })}\n\n`) || wroteDownstream;
                      prevTool.closed = true;
                    }
                  }
                }

                activeToolCalls[tc.index] = {
                  id: tc.id || `call_${crypto.randomUUID()}`,
                  name: tc.function?.name || "",
                  emittedStart: false,
                  closed: false,
                };
              }

              const tool = activeToolCalls[tc.index];
              if (tc.function?.name && !tool.name) tool.name = tc.function.name;

              if (!tool.emittedStart && tool.name) {
                wroteDownstream = downstream.write(`event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: anthropicBlockIndex + tc.index,
                  content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
                })}\n\n`) || wroteDownstream;
                tool.emittedStart = true;
              }

              if (tc.function?.arguments && tool.emittedStart) {
                wroteDownstream = downstream.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: anthropicBlockIndex + tc.index,
                  delta: { type: "input_json_delta", partial_json: tc.function.arguments },
                })}\n\n`) || wroteDownstream;
                meaningfulClientOutputSent = true;
              }
            }
          }

          if (!wroteDownstream) {
            downstream.pingIfIdle(HIDDEN_PROGRESS_KEEP_ALIVE_MS);
          }
        } catch (err) {
          if (!(err instanceof SyntaxError)) {
            throw err;
          }
          // Unparseable upstream data — skip in adapted mode
        }
      }
    }
  }
  } catch (err: any) {
    if (streamTimeoutId) clearTimeout(streamTimeoutId);

    const isTimeout = err.message === "Stream chunk timeout";
    const statusCode = isTimeout ? 504 : 502;
    const classified = classifyUpstreamErrorWithAdapter(
      adapter,
      {
        rawError: err,
        statusCode,
        phase: "stream",
      },
      adapterContext
    );

    if (adapterState) {
      adapterState.terminalError = classified;
    }

    await reader.cancel().catch(() => {});

    if (logAction && baseActionLog) {
      logAction({
        ...baseActionLog,
        level: "ERROR",
        code: "request.provider_adapter.stream_error",
        adapterId: adapter?.id || "transparent",
        errorCode: classified.code,
        errorType: classified.errorType,
        message: `Stream exception: ${classified.message}`,
      });
    }

    let sentEvent = false;
    if (meaningfulClientOutputSent) {
      downstream.write(formatStreamErrorEvent("anthropic", statusCode, classified.message));
      sentEvent = true;
    } else {
      // transient/early stream error - don't emit downstream so orchestrator can retry
    }

    observer?.onStreamEnd?.();
    return { gotFirstChunk, isLengthTruncated: false, terminalEventSent: sentEvent, terminalError: classified, meaningfulClientOutputSent };
  } finally {
    downstream.stop();
  }

  // ─── Anthropic stream finalization ───
  if (!stitchState?.isStitching || stitchState?.isLastCycle) {
    if (isInsideTextBlock) {
      downstream.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index: anthropicBlockIndex,
      })}\n\n`);
    }
    for (const tcIndexStr in activeToolCalls) {
      const tcIndex = parseInt(tcIndexStr);
      const tool = activeToolCalls[tcIndex];
      if (!tool.closed && tool.emittedStart) {
        downstream.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: anthropicBlockIndex + tcIndex,
        })}\n\n`);
        tool.closed = true;
      }
    }

    let stopReason = "end_turn";
    if (hadLengthCutoff) {
      stopReason = "max_tokens";
    } else if (Object.keys(activeToolCalls).length > 0) {
      stopReason = "tool_use";
    }

    const totalOutputTokens = (context as any)?.continuity?.completionTokens || observer?.getCompletionTokens?.() || 0;

    downstream.write(`event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: {
        output_tokens: totalOutputTokens,
      },
    })}\n\n`);

    downstream.write(`event: message_stop\ndata: ${JSON.stringify({
      type: "message_stop",
    })}\n\n`);
  }

  let finalClosingSentinel: string | undefined;
  if (hadLengthCutoff) {
    let sentinel = "";
    if (isInsideTextBlock) {
      sentinel += `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicBlockIndex })}\n\n`;
    }
    for (const tcIndexStr in activeToolCalls) {
      const tcIndex = parseInt(tcIndexStr);
      const tool = activeToolCalls[tcIndex];
      if (!tool.closed && tool.emittedStart) {
        sentinel += `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicBlockIndex + tcIndex })}\n\n`;
      }
    }
    finalClosingSentinel = sentinel;
  }

  observer?.onStreamEnd?.();

  const newAnthropicState = {
    activeBlockIndex: anthropicBlockIndex,
    isInsideTextBlock: isInsideTextBlock,
    activeToolCalls: activeToolCalls,
  };

  return { gotFirstChunk, isLengthTruncated: hadLengthCutoff, closingSentinel: finalClosingSentinel, anthropicState: newAnthropicState, meaningfulClientOutputSent };
}
