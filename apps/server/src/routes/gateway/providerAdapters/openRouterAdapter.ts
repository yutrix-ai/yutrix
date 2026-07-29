import { ProviderAdapter, ProviderAdapterContext, StreamObservation, StreamTerminalError } from "./types";
import { parseAndNormalizeUrl } from "./urlMatcher";
import crypto from "crypto";

function extractTextFromReasoningDetails(details: any): string {
  if (!details) return "";
  if (typeof details === "string") return details;
  if (Array.isArray(details)) {
    return details
      .map(item => extractTextFromReasoningDetails(item))
      .filter(Boolean)
      .join("");
  }
  if (typeof details === "object") {
    // Skip purely encrypted/opaque blocks (no readable text fields)
    const isEncrypted = details.type === "encrypted" ||
      (details.encrypted && !details.text && !details.summary && !details.content);
    if (isEncrypted) {
      return "";
    }
    // Extract readable text fields (text, summary, content)
    // Ignore opaque fields (signature, ciphertext, data, payload)
    if (typeof details.text === "string") return details.text;
    if (typeof details.summary === "string") return details.summary;
    if (typeof details.content === "string") return details.content;
  }
  return "";
}

// Helper: map errorType string to HTTP status code
const errorTypeToStatus: Record<string, number> = {
  rate_limit_exceeded: 429,
  authentication: 401,
  provider_overloaded: 503,
  provider_unavailable: 503,
};

function normalizeMessageForFingerprint(message: string): string {
  let norm = message.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "uuid-placeholder");
  norm = norm.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "timestamp-placeholder");
  norm = norm.replace(/\d+/g, "\\d");
  return norm;
}

// Helper: build a clean StreamTerminalError from a raw error object
function classifyError(input: { rawError: any, statusCode?: number, phase: "http" | "nonstream" | "fake_stream" | "stream" }, context?: ProviderAdapterContext): StreamTerminalError | undefined {
  if (!input.rawError) return undefined;
  const err = input.rawError;
  let message = err?.message || "Unknown OpenRouter error";
  if (err?.error?.message) {
    message = err.error.message;
  }

  // Try to parse Nvidia ResourceExhausted
  const isResourceExhausted = message.toLowerCase().includes("resourceexhausted") || message.toLowerCase().includes("resource exhausted");
  const isLocalLimit = message.toLowerCase().includes("local total request limit") || message.toLowerCase().includes("provider capacity exhausted");

  let upstreamProvider = err?.metadata?.provider_name || err?.metadata?.provider || err?.provider;
  if (!upstreamProvider) {
    const match = message.match(/Upstream error from\s+([^:]+):/i);
    if (match) {
      upstreamProvider = match[1].trim();
    }
  }

  // Model capability mismatch (image input unsupported)
  const isImageUnsupported = message.toLowerCase().includes("no endpoints found that support image input");
  if (isImageUnsupported) {
    const normMsg = normalizeMessageForFingerprint(message);
    const fingerprintStr = `openrouter|${upstreamProvider || ""}|model_image_input_unsupported|model_capability_mismatch|${normMsg}`;
    const fingerprint = crypto.createHash("sha256").update(fingerprintStr).digest("hex").slice(0, 16);
    return {
      statusCode: input.statusCode || 400,
      code: "model_image_input_unsupported",
      errorType: "model_capability_mismatch",
      message: message,
      retryable: false,
      retryClass: "invalid_request",
      adapterId: "openrouter",
      upstreamProvider: upstreamProvider || "OpenRouter",
      phase: input.phase,
      requiredCapability: "vision",
      fingerprint,
      safeMetadata: {},
    } as any;
  }

  if (isResourceExhausted && isLocalLimit) {
    const normMsg = normalizeMessageForFingerprint(message);
    const fingerprintStr = `openrouter|${upstreamProvider || "Nvidia"}|provider_capacity_exhausted|provider_overloaded|${normMsg}`;
    const fingerprint = crypto.createHash("sha256").update(fingerprintStr).digest("hex").slice(0, 16);
    return {
      statusCode: 503,
      code: "provider_capacity_exhausted",
      errorType: "provider_overloaded",
      message: message, // Preserve exact message like (79/32)
      retryable: true,
      retryClass: "provider_capacity",
      adapterId: "openrouter",
      upstreamProvider: upstreamProvider || "Nvidia",
      phase: input.phase,
      fingerprint,
      safeMetadata: {},
    };
  }

  const isInvalidAnthropicMessages = message.toLowerCase().includes("invalid anthropic messages api request");
  let isUnknownServerTool = false;

  if (isInvalidAnthropicMessages && err?.error?.metadata?.raw) {
    try {
      const rawParsed = JSON.parse(err.error.metadata.raw);
      if (Array.isArray(rawParsed)) {
        for (const item of rawParsed) {
          if (
            item.path &&
            Array.isArray(item.path) &&
            item.path.length >= 3 &&
            item.path[0] === "tools" &&
            item.path[2] === "type" &&
            item.message === "Unknown server-tool shorthand"
          ) {
            isUnknownServerTool = true;
            break;
          }
        }
      }
    } catch {
      // Ignore parse errors for raw
    }
  }

  if (isUnknownServerTool) {
    const normMsg = normalizeMessageForFingerprint(message);
    const fingerprintStr = `openrouter|${upstreamProvider || ""}|unsupported_server_tool_shorthand|protocol_payload_incompatible|${normMsg}`;
    const fingerprint = crypto.createHash("sha256").update(fingerprintStr).digest("hex").slice(0, 16);
    return {
      statusCode: input.statusCode || 400,
      code: "unsupported_server_tool_shorthand",
      errorType: "protocol_payload_incompatible",
      message: message, // Inner error message
      retryable: false,
      retryClass: "protocol_payload_incompatible",
      adapterId: "openrouter",
      upstreamProvider: upstreamProvider || "OpenRouter",
      phase: input.phase,
      fingerprint,
      safeMetadata: {},
    } as any;
  }

  // OpenRouter: deferred custom tools (defer_loading / tools omitted from tools[])
  // are Anthropic-first-party only. Treat as protocol payload incompatibility so
  // funnel fallback can switch models instead of spinning retries on the same free model.
  const lowerMessage = message.toLowerCase();
  const isDeferredToolsUnsupported =
    lowerMessage.includes("deferred custom tools") ||
    (lowerMessage.includes("deferred") &&
      lowerMessage.includes("only supported on anthropic")) ||
    (lowerMessage.includes("cannot call tools omitted from tools") &&
      lowerMessage.includes("non-anthropic"));

  if (isDeferredToolsUnsupported) {
    const normMsg = normalizeMessageForFingerprint(message);
    const fingerprintStr = `openrouter|${upstreamProvider || ""}|deferred_custom_tools_unsupported|protocol_payload_incompatible|${normMsg}`;
    const fingerprint = crypto.createHash("sha256").update(fingerprintStr).digest("hex").slice(0, 16);
    return {
      statusCode: input.statusCode || 400,
      code: "deferred_custom_tools_unsupported",
      errorType: "protocol_payload_incompatible",
      message: message,
      retryable: false,
      retryClass: "protocol_payload_incompatible",
      adapterId: "openrouter",
      upstreamProvider: upstreamProvider || "OpenRouter",
      phase: input.phase,
      fingerprint,
      safeMetadata: {},
    } as any;
  }

  const errorType = err?.metadata?.error_type || err?.type || "upstream_error";
  const rawCode = err?.code;
  let statusCode = input.statusCode;
  if (typeof rawCode === "number") {
    statusCode = rawCode;
  } else if (!statusCode) {
    statusCode = errorTypeToStatus[errorType] ?? 502;
  }

  // Safe metadata
  const safeKeys = ["provider_name", "provider", "error_type", "request_id", "upstream_request_id", "code", "status", "retry_after", "model"];
  const safeMetadata: Record<string, string | number | boolean | null> = {};
  const allMetaKeys: string[] = [];

  if (err?.metadata && typeof err.metadata === "object") {
    let fieldCount = 0;
    for (const [k, v] of Object.entries(err.metadata)) {
      allMetaKeys.push(k);

      const lowerKey = k.toLowerCase();
      if (
        lowerKey === "raw" ||
        lowerKey.includes("api_key") ||
        lowerKey.includes("password") ||
        lowerKey.includes("token") ||
        lowerKey.includes("secret") ||
        lowerKey.includes("message") ||
        lowerKey.includes("prompt") ||
        lowerKey.includes("base64")
      ) {
        continue;
      }

      if (safeKeys.includes(k) && fieldCount < 15) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) {
          let finalVal = v;
          if (typeof finalVal === "string") {
            if (finalVal.length > 256) {
              finalVal = finalVal.substring(0, 256) + "...";
            }
          }
          safeMetadata[k] = finalVal;
          fieldCount++;
        }
      }
    }
  }
  if (allMetaKeys.length > 0) {
    safeMetadata["_metadataKeys"] = allMetaKeys.join(",").substring(0, 256);
  }

  let metaStr = JSON.stringify(safeMetadata);
  if (metaStr.length > 2048) {
    metaStr = metaStr.substring(0, 2048);
  }
  let finalMeta = {};
  try {
    finalMeta = JSON.parse(metaStr);
  } catch {
    const recon: any = {};
    for (const [k, v] of Object.entries(safeMetadata)) {
      if (JSON.stringify(recon).length + JSON.stringify({[k]: v}).length < 2000) {
        recon[k] = v;
      }
    }
    finalMeta = recon;
  }

  const normMsg = normalizeMessageForFingerprint(message);
  const fingerprintStr = `openrouter|${upstreamProvider || ""}|${rawCode || ""}|${errorType}|${normMsg}`;
  const fingerprint = crypto.createHash("sha256").update(fingerprintStr).digest("hex").slice(0, 16);

  let retryable = false;
  let retryClass: any = "unknown";

  if (errorType === "rate_limit_exceeded" || rawCode == 429 || statusCode == 429) {
    retryClass = "rate_limit";
    retryable = true; // Gateway controls actual retry budget; retryable suppresses premature client error event
    statusCode = 429;
  } else if (errorType === "provider_unavailable" || errorType === "provider_overloaded") {
    retryClass = "provider_unavailable";
    retryable = true; // Same: allow gateway-level fallback
  } else if (errorType === "invalid_api_key" || errorType === "authentication_error" || rawCode == 401 || statusCode == 401) {
    retryClass = "authentication";
    retryable = true; // Allow key rotation
    statusCode = 401;
  }

  const result: StreamTerminalError = {
    statusCode,
    code: rawCode != null ? String(rawCode) : "upstream_error",
    errorType,
    message,
    retryable,
    retryClass,
    adapterId: "openrouter",
    upstreamProvider,
    upstreamCode: rawCode != null ? String(rawCode) : undefined,
    upstreamErrorType: errorType,
    safeMetadata: finalMeta,
    fingerprint,
    phase: input.phase
  };

  if (retryClass === "authentication") {
    result.targetScoped = true;
    result.persistentKeyDisable = false;
  }

  return result;
}

/**
 * Whether this attempt is bound to OpenRouter's *native Anthropic* surface.
 *
 * `context.providerProtocol` is the protocol of the **selected base URL**
 * (openaiBaseUrl vs anthropicBaseUrl), not the client's incoming protocol.
 * - anthropic → `/messages` + Anthropic payload passthrough
 * - openai    → OpenAI-compatible; Anthropic clients must go through protocol
 *               conversion (drops Anthropic-only fields such as defer_loading)
 */
export function isOpenRouterNativeAnthropicAttempt(context: {
  incomingProtocol?: string;
  providerProtocol?: string;
}): boolean {
  return context.incomingProtocol === "anthropic" && context.providerProtocol === "anthropic";
}

/** Known Anthropic server-tool shorthands that OpenRouter rejects on many models. */
const UNSUPPORTED_OPENROUTER_ANTHROPIC_SERVER_TOOL_TYPES = new Set([
  "tool_search_tool_regex_20251119",
  "tool_search_tool_bm25_20251119",
]);

function isUnsupportedOpenRouterServerToolType(type: unknown): boolean {
  if (typeof type !== "string" || !type) return false;
  if (UNSUPPORTED_OPENROUTER_ANTHROPIC_SERVER_TOOL_TYPES.has(type)) return true;
  // Future-proof: any tool_search_tool_* shorthand is Anthropic-native.
  return type.startsWith("tool_search_tool_");
}

export const openRouterAdapter: ProviderAdapter = {
  id: "openrouter",
  match(context: ProviderAdapterContext): boolean {
    const parsed = parseAndNormalizeUrl(context.rawBaseUrl);
    if (!parsed.isValid) return false;

    // OpenRouter matches openrouter.ai hostname exactly
    if (parsed.hostname === "openrouter.ai") {
      const pathname = parsed.pathname;
      // Accept /api/v1, /api/v1/, /api/v1/chat/completions, and any /api/v1/ prefix
      return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
    }
    return false;
  },

  effectiveUpstreamProtocol(context: ProviderAdapterContext): string | undefined {
    // Only native Anthropic when the selected base URL is the Anthropic slot.
    // OpenAI-URL-only providers must use OpenAI-compatible upstream so
    // Anthropic→OpenAI conversion runs (and strips Anthropic-only tool fields).
    if (context.incomingProtocol === "anthropic") {
      if (context.providerProtocol === "anthropic") return "anthropic";
      if (context.providerProtocol === "openai") return "openai";
    }
    return undefined;
  },

  classifyUpstreamError(input: { rawError: unknown; statusCode?: number; phase: "http" | "nonstream" | "fake_stream" | "stream" }, context: ProviderAdapterContext): StreamTerminalError | undefined {
    return classifyError(input, context);
  },

  overrideUpstreamBaseUrl(context: ProviderAdapterContext, originalBaseUrl: string): string | undefined {
    // Strip trailing endpoints if users mistakenly added them to the base URL
    const match = originalBaseUrl.match(/^(https?:\/\/openrouter\.ai\/api\/v1)(\/chat\/completions)?\/?$/i);
    if (match) {
      return match[1];
    }
    return undefined;
  },

  overrideUpstreamPath(context: ProviderAdapterContext, originalPath: string): string | undefined {
    // Native Anthropic surface only when anthropicBaseUrl (anthropic-bound URL) was selected.
    if (isOpenRouterNativeAnthropicAttempt(context)) {
      return "/messages";
    }
    return undefined;
  },

  adaptUpstreamHeaders(context: ProviderAdapterContext, originalHeaders: Record<string, string>): Record<string, string> | undefined {
    // Normalize auth for OpenRouter; Anthropic client headers only on native Anthropic surface.
    if (context.incomingProtocol === "anthropic" || context.providerProtocol === "openai") {
      const headers = { ...originalHeaders };
      if (headers["x-api-key"]) {
        headers["authorization"] = `Bearer ${headers["x-api-key"]}`;
        delete headers["x-api-key"];
      }

      if (isOpenRouterNativeAnthropicAttempt(context) && context.clientHeaders) {
        const allowed = ["anthropic-version", "anthropic-beta", "x-anthropic-client", "user-agent"];
        for (const [k, v] of Object.entries(context.clientHeaders)) {
          const lowerKey = k.toLowerCase();
          if (allowed.includes(lowerKey) && v !== undefined) {
            headers[lowerKey] = Array.isArray(v) ? v.join(", ") : v;
          }
        }
      }
      return headers;
    }
    return undefined;
  },

  bypassProtocolAdaptation(context: ProviderAdapterContext): boolean | undefined {
    // Pass Anthropic payloads through only on the native Anthropic URL.
    // OpenAI-URL-only OpenRouter must convert Anthropic → OpenAI.
    if (isOpenRouterNativeAnthropicAttempt(context)) return true;
    return undefined;
  },

  adaptRequestBody(context: ProviderAdapterContext, body: any, helpers: { logAction: any, baseActionLog: any }): any {
    // Server-tool shorthand cleanup only for native Anthropic passthrough.
    // Converted OpenAI bodies already drop these in protocolAdapter.
    if (isOpenRouterNativeAnthropicAttempt(context) && body && Array.isArray(body.tools)) {
      const toolsToRemove = body.tools.filter((t: any) =>
        t.type && isUnsupportedOpenRouterServerToolType(t.type)
      );

      if (toolsToRemove.length > 0) {
        const removedNames = toolsToRemove.map((t: any) => t.name || t.type);
        let hasReference = false;

        // Check tool_choice
        if (body.tool_choice && body.tool_choice.name && removedNames.includes(body.tool_choice.name)) {
          hasReference = true;
        }

        const knownToolUseIds = new Set<string>();
        const removedToolUseIds = new Set<string>();

        if (Array.isArray(body.messages)) {
          for (const msg of body.messages) {
            if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block.type === "tool_use") {
                  knownToolUseIds.add(block.id);
                  if (removedNames.includes(block.name)) {
                    hasReference = true;
                    removedToolUseIds.add(block.id);
                  }
                } else if (block.type === "tool_result") {
                  // If it refers to a removed tool use, or if it is isolated (no known tool_use in history)
                  if (removedToolUseIds.has(block.tool_use_id) || !knownToolUseIds.has(block.tool_use_id)) {
                    hasReference = true;
                  }
                }
              }
            }
          }
        }

        if (hasReference) {
          const err: any = new Error("Unsupported server-tool shorthand referenced in history or tool_choice");
          err.code = "unsupported_server_tool_shorthand";
          err.errorType = "protocol_payload_incompatible";
          throw err;
        }

        body.tools = body.tools.filter((t: any) => !toolsToRemove.includes(t));
        if (body.tools.length === 0) delete body.tools;

        helpers.logAction({
          ...helpers.baseActionLog,
          level: "WARN",
          code: "request.openrouter.unsupported_server_tool_removed",
          providerName: context.providerName,
          modelId: context.modelId,
          removedToolTypes: toolsToRemove.map((t: any) => t.type),
          removedToolNames: removedNames,
          remainingToolCount: body.tools ? body.tools.length : 0,
          message: `Removed unsupported server-tool shorthands: ${removedNames.join(", ")}`,
        });
      }
    }
    return body;
  },

  createAttemptState(_context: ProviderAdapterContext): any {
    return {
      hadMeaningfulAdapterEvent: false,
      terminalError: null,
    };
  },

  getRequestPolicy(_context: ProviderAdapterContext) {
    return {
      exemptAssistantHistoryFields: ["reasoning", "reasoning_details"],
      preserveFakeStreamFields: ["reasoning", "reasoning_details"],
    };
  },

  observeStreamChunk(chunkCopy: any, state: any, context: ProviderAdapterContext): StreamObservation | void {
    if (!chunkCopy) return;
    const observation: StreamObservation = {};

    // 1. Observe terminal error
    if (chunkCopy.error) {
      if (!state.terminalError) {
        const termErr = classifyError({ rawError: chunkCopy.error, phase: "stream" }, context);
        if (termErr) {
          state.terminalError = termErr;
          observation.terminalError = termErr;
        }
      }
    }

    // --- Anthropic Format Parsing (for Anthropic upstream) ---
    if (context.incomingProtocol === "anthropic") {
      if (chunkCopy.type === "message_start" && chunkCopy.message?.usage) {
        if (!observation.usage) observation.usage = {};
        observation.usage.prompt_tokens = chunkCopy.message.usage.input_tokens;
      } else if (chunkCopy.type === "message_delta" && chunkCopy.usage) {
        if (!observation.usage) observation.usage = {};
        observation.usage.completion_tokens = chunkCopy.usage.output_tokens;
      }

      if (chunkCopy.type === "content_block_start" && chunkCopy.content_block?.type === "redacted_thinking") {
        observation.meaningful = true;
      } else if (chunkCopy.type === "content_block_delta" && chunkCopy.delta?.type === "thinking_delta") {
        observation.meaningful = true;
        if (chunkCopy.delta.thinking) {
          observation.reasoningText = chunkCopy.delta.thinking;
        }
      }
      return observation;
    }

    // --- OpenAI Format Parsing (default) ---
    const choices = chunkCopy.choices;
    if (!choices || !Array.isArray(choices) || choices.length === 0) {
      if (chunkCopy.usage) {
        observation.usage = chunkCopy.usage;
      }
      return observation;
    }
    const delta = choices[0].delta;
    const finishReason = choices[0].finish_reason;

    if (finishReason === "error") {
      if (!state.terminalError) {
        const fallbackErr = choices[0].error || delta?.error;
        if (fallbackErr) {
          const termErr = classifyError({ rawError: fallbackErr, phase: "stream" }, context);
          if (termErr) {
            state.terminalError = termErr;
            observation.terminalError = termErr;
          }
        } else {
          const termErr = classifyError({ rawError: { type: "upstream_error", message: "Upstream finish_reason was error" }, phase: "stream" }, context);
          if (termErr) {
            state.terminalError = termErr;
            observation.terminalError = termErr;
          }
        }
      }
    }

    let hasReasoning = false;
    let text = "";

    if (delta) {
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        text += delta.reasoning_content;
        hasReasoning = true;
      }
      if (typeof delta.reasoning === "string" && delta.reasoning) {
        text += delta.reasoning;
        hasReasoning = true;
      }
      if (delta.reasoning_details) {
        const isDetailsNotEmpty = Array.isArray(delta.reasoning_details)
          ? delta.reasoning_details.length > 0
          : !!delta.reasoning_details;

        if (isDetailsNotEmpty) {
          hasReasoning = true;
          const readable = extractTextFromReasoningDetails(delta.reasoning_details);
          if (readable) {
            text += readable;
          }
        }
      }
    }

    if (hasReasoning) {
      state.hadMeaningfulAdapterEvent = true;
      observation.meaningful = true;
      if (text) {
        observation.reasoningText = text;
      }
    }

    if (chunkCopy.usage) {
      observation.usage = chunkCopy.usage;
    }

    return observation;
  },

  observeNonStreamResponse(responseCopy: any, state: any, context: ProviderAdapterContext): StreamObservation | void {
    if (!responseCopy) return;
    const observation: StreamObservation = {};

    // 1. Observe terminal error
    // top-level error is authoritative
    if (responseCopy.error) {
      const termErr = classifyError({ rawError: responseCopy.error, phase: "nonstream" }, context);
      if (termErr) {
        state.terminalError = termErr;
        observation.terminalError = termErr;
      }
    }

    // --- Anthropic Format Parsing (for Anthropic upstream) ---
    if (context.incomingProtocol === "anthropic") {
      if (responseCopy.usage) {
        if (!observation.usage) observation.usage = {};
        if (responseCopy.usage.input_tokens) observation.usage.prompt_tokens = responseCopy.usage.input_tokens;
        if (responseCopy.usage.output_tokens) observation.usage.completion_tokens = responseCopy.usage.output_tokens;
      }

      if (responseCopy.content && Array.isArray(responseCopy.content)) {
        let hasReasoning = false;
        let text = "";
        for (const block of responseCopy.content) {
          if (block.type === "redacted_thinking") {
            hasReasoning = true;
          } else if (block.type === "thinking") {
            hasReasoning = true;
            if (block.thinking) {
              text += block.thinking;
            }
          }
        }
        if (hasReasoning) {
          observation.meaningful = true;
          if (text) {
            observation.reasoningText = text;
          }
        }
      }
      return observation;
    }

    const choice = responseCopy.choices?.[0];

    if (choice?.finish_reason === "error") {
      if (!state.terminalError) {
        const fallbackErr = choice.error || choice.message?.error;
        if (fallbackErr) {
          const termErr = classifyError({ rawError: fallbackErr, phase: "nonstream" }, context);
          if (termErr) {
            state.terminalError = termErr;
            observation.terminalError = termErr;
          }
        } else {
          const termErr = classifyError({ rawError: { type: "upstream_error", message: "Upstream finish_reason was error" }, phase: "nonstream" }, context);
          if (termErr) {
            state.terminalError = termErr;
            observation.terminalError = termErr;
          }
        }
      }
    }

    const msg = choice?.message;
    let hasReasoning = false;
    let text = "";

    if (msg) {
      if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
        text += msg.reasoning_content;
        hasReasoning = true;
      }
      if (typeof msg.reasoning === "string" && msg.reasoning) {
        text += msg.reasoning;
        hasReasoning = true;
      }
      if (msg.reasoning_details) {
        const isDetailsNotEmpty = Array.isArray(msg.reasoning_details)
          ? msg.reasoning_details.length > 0
          : !!msg.reasoning_details;

        if (isDetailsNotEmpty) {
          hasReasoning = true;
          const readable = extractTextFromReasoningDetails(msg.reasoning_details);
          if (readable) {
            text += readable;
          }
        }
      }
    }

    if (hasReasoning) {
      observation.meaningful = true;
      if (text) {
        observation.reasoningText = text;
      }
    }

    if (responseCopy.usage) {
      observation.usage = responseCopy.usage;
    }

    return observation;
  },
};
