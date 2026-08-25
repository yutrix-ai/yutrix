import crypto from "crypto";
import {
  NormalizedLogInfo,
  normalizeImageBlock,
  normalizeOpenAIContentParts,
} from "../../utils/multimodal";
import {
  applyAnthropicCompatibleOutbound,
  type AnthropicOutboundSurface,
} from "./anthropicOutboundProfile";

/** Client-echoed assistant fields required by thinking-mode + tools continuations. */
const ASSISTANT_PASSBACK_MESSAGE_FIELDS = [
  "reasoning_content",
  "reasoning",
] as const;

/** Response-only metadata that must not be forwarded on the default OpenAI path. */
const NEVER_FORWARD_LEAK_MESSAGE_FIELDS = [
  "reasoning_details",
  "thinking",
  "thinking_content",
  "redacted_reasoning",
  "extra_content",
  "provider_specific_fields",
] as const;

const RESPONSE_ONLY_CONTENT_BLOCK_TYPES = new Set([
  "reasoning",
  "reasoning_content",
  "thinking",
  "thinking_content",
  "redacted_reasoning",
]);

function isResponseOnlyContentBlock(block: any): boolean {
  return !!(
    block &&
    typeof block === "object" &&
    RESPONSE_ONLY_CONTENT_BLOCK_TYPES.has(String(block.type || ""))
  );
}

/** Anthropic server-tool shorthands have no OpenAI function equivalent. */
function isAnthropicServerToolName(name: unknown): boolean {
  if (typeof name !== "string" || !name) return false;
  return name.startsWith("tool_search_tool_") || name.startsWith("tool_search");
}

function isAnthropicServerToolDef(tool: any): boolean {
  if (!tool || typeof tool !== "object") return false;
  if (typeof tool.type === "string" && tool.type.startsWith("tool_search_tool_")) return true;
  if (isAnthropicServerToolName(tool.name)) return true;
  return false;
}

function sanitizeOpenAIMessageForUpstream(message: any, requestPolicy?: any): void {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return;
  }

  const isAssistant = message.role === "assistant";
  const exemptFields = (isAssistant && requestPolicy?.exemptAssistantHistoryFields) || [];

  for (const field of ASSISTANT_PASSBACK_MESSAGE_FIELDS) {
    if (isAssistant) continue;
    delete message[field];
  }

  for (const field of NEVER_FORWARD_LEAK_MESSAGE_FIELDS) {
    if (exemptFields.includes(field)) continue;
    delete message[field];
  }

  if (Array.isArray(message.content)) {
    message.content = message.content.filter((block: any) => {
      if (!block || typeof block !== "object") return true;
      const blockType = String(block.type || "");
      if (RESPONSE_ONLY_CONTENT_BLOCK_TYPES.has(blockType)) {
        if (message.role === "assistant" && exemptFields.includes(blockType)) {
          return true;
        }
        return false;
      }
      return true;
    });
  }
}

function isOpenAITextPart(block: any): boolean {
  return block && typeof block === "object" && block.type === "text";
}

function sanitizeOpenAIContentPart(block: any): any {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return block;
  }

  if (block.type === "text") {
    return { type: "text", text: typeof block.text === "string" ? block.text : String(block.text ?? "") };
  }

  if (block.type === "image_url") {
    return { type: "image_url", image_url: block.image_url };
  }

  return block;
}

function buildOpenAIContentFromParts(parts: any[]): any {
  if (parts.length === 0) return undefined;

  // Google's OpenAI-compatible endpoint is stricter than OpenAI here: a pure
  // text array can intermittently fail, especially when Anthropic cache_control
  // metadata is present. Collapse adjacent text blocks into the canonical chat
  // string form and only keep arrays for true multimodal content.
  if (parts.every(isOpenAITextPart)) {
    return parts.map((part) => typeof part.text === "string" ? part.text : String(part.text ?? "")).join("");
  }

  return parts.map(sanitizeOpenAIContentPart);
}

function fillOpenAIMessageContent(message: any): void {
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

  if (hasToolCalls && (message.content === undefined || message.content === null || message.content === "")) {
    message.content = null;
    return;
  }

  if (message.content !== undefined && message.content !== null) {
    return;
  }

  message.content = "";
}

function extractSystemText(content: any): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== "object") return String(block ?? "");
        if (block.type === "text") return typeof block.text === "string" ? block.text : String(block.text ?? "");
        if (block.content !== undefined) return extractSystemText(block.content);
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text.trim();
    if (content.content !== undefined) return extractSystemText(content.content);
    return JSON.stringify(content);
  }
  return String(content).trim();
}

function pushSystemText(parts: string[], content: any): void {
  const text = extractSystemText(content);
  if (text) parts.push(text);
}

/**
 * Adapt the request body from the incoming protocol to the upstream protocol.
 *
 * - Anthropic → OpenAI-compatible: deep conversion of system, messages,
 *   tools, tool_choice, multimodal blocks, etc.
 * - OpenAI → OpenAI (non-Anthropic upstream): normalize multimodal content
 *   parts via normalizeOpenAIContentParts.
 *
 * Returns the transformed body and normalisation log info so the caller can
 * persist audit entries.
 */
export function adaptRequestProtocol(
  body: any,
  incomingProtocol: string,
  isAnthropicUpstream: boolean,
  isStreaming: boolean,
  modelId: string,
  baseActionLog: any,
  logAction: Function,
  requestPolicy?: any,
  outbound?: AnthropicOutboundSurface,
): { finalBody: any; logInfo: NormalizedLogInfo } {
  const logInfo: NormalizedLogInfo = {
    detected: false,
    normalized: false,
    details: [],
  };
  let finalBody = body;

  if (incomingProtocol === "anthropic" && !isAnthropicUpstream) {
    logAction({
      ...baseActionLog,
      level: "INFO",
      code: "request.protocol_adapted",
      providerName: baseActionLog.providerName,
      modelId: modelId,
      message: `入站协议=Anthropic 目标协议=OpenAI-compatible`,
    });

    finalBody = {
      model: modelId,
      messages: [],
      stream: isStreaming,
    };
    const systemTextParts: string[] = [];
    if (isStreaming) {
      finalBody.stream_options = { include_usage: true };
    }
    if (body.max_tokens !== undefined)
      finalBody.max_tokens = body.max_tokens;
    if (body.max_completion_tokens !== undefined)
      finalBody.max_completion_tokens = body.max_completion_tokens;
    if (body.temperature !== undefined)
      finalBody.temperature = body.temperature;
    if (body.top_p !== undefined) finalBody.top_p = body.top_p;

    if (body.system) {
      pushSystemText(systemTextParts, body.system);
    }

    // Track server-tool uses dropped from history so matching tool_results can be dropped too.
    const droppedServerToolUseIds = new Set<string>();

    if (Array.isArray(body.tools)) {
      // Anthropic → OpenAI tools: keep only OpenAI-compatible function tools.
      // Intentionally drop Anthropic-only semantics (defer_loading, tool_search
      // server-tool shorthands, cache_control on tools, etc.). Building a fresh
      // function object is the protocol boundary — do not pass Anthropic fields through.
      finalBody.tools = body.tools
        .map((t: any) => {
          if (!t || typeof t !== "object") return null;
          // Already OpenAI function format
          if (t.type === "function" && t.function?.name) {
            if (isAnthropicServerToolName(t.function.name)) return null;
            return {
              type: "function",
              function: {
                name: t.function.name,
                description: t.function.description,
                parameters: t.function.parameters ?? { type: "object", properties: {} },
              },
            };
          }
          // Anthropic server-tool shorthands (tool_search_tool_*, …) — no OpenAI equivalent.
          if (isAnthropicServerToolDef(t)) return null;
          if (typeof t.type === "string" && t.type !== "custom" && t.type !== "function" && !t.name) {
            return null;
          }
          if (!t.name) return null;
          return {
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.input_schema ?? { type: "object", properties: {} },
            },
          };
        })
        .filter(Boolean);
      if (finalBody.tools.length === 0) delete finalBody.tools;
    }
    if (body.tool_choice) {
      if (body.tool_choice.type === "auto") {
        finalBody.tool_choice = "auto";
      } else if (body.tool_choice.type === "any") {
        finalBody.tool_choice = "required";
      } else if (body.tool_choice.type === "tool") {
        finalBody.tool_choice = {
          type: "function",
          function: { name: body.tool_choice.name },
        };
      }
    }

    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg.role === "system" || msg.role === "developer") {
          pushSystemText(systemTextParts, msg.content);
          continue;
        }

        if (Array.isArray(msg.content)) {
          let finalContentParts: any[] = [];
          let toolCalls: any[] = [];
          let hasToolResult = false;
          let keptAnyBlock = false;

          for (const block of msg.content) {
            if (isResponseOnlyContentBlock(block)) {
              continue;
            }

            if (block.type === "text") {
              finalContentParts.push(sanitizeOpenAIContentPart(block));
              keptAnyBlock = true;
            } else if (
              block.type === "image_url" ||
              block.type === "image" ||
              block.type === "file" ||
              block.type === "input_image" ||
              block.type === "input-image"
            ) {
              finalContentParts.push(normalizeImageBlock(block, logInfo));
              keptAnyBlock = true;
            } else if (block.type === "tool_use") {
              // Drop Anthropic server-tool uses — no OpenAI equivalent (same boundary as tools[]).
              if (isAnthropicServerToolName(block.name)) {
                if (block.id) droppedServerToolUseIds.add(block.id);
                continue;
              }
              toolCalls.push({
                id: block.id,
                type: "function",
                function: {
                  name: block.name,
                  arguments:
                    typeof block.input === "string"
                      ? block.input
                      : JSON.stringify(block.input || {}),
                },
              });
              keptAnyBlock = true;
            } else if (block.type === "tool_result") {
              if (block.tool_use_id && droppedServerToolUseIds.has(block.tool_use_id)) {
                continue;
              }
              hasToolResult = true;
              keptAnyBlock = true;
              if (finalContentParts.length > 0) {
                finalBody.messages.push({
                  role: msg.role,
                  content: buildOpenAIContentFromParts(finalContentParts),
                });
                finalContentParts = [];
              }
              let resultStr = "";
              if (typeof block.content === "string") {
                resultStr = block.content;
              } else if (Array.isArray(block.content)) {
                resultStr = block.content
                  .map((c: any) => c.text || "")
                  .join("\n");
              } else {
                resultStr = JSON.stringify(block.content || "");
              }
              finalBody.messages.push({
                role: "tool",
                tool_call_id: block.tool_use_id,
                content: resultStr,
              });
            } else {
              finalContentParts.push(normalizeImageBlock(block, logInfo));
            }
          }

          // Entire message was Anthropic-only server-tool noise — drop it.
          if (!keptAnyBlock) {
            continue;
          }

          if (!hasToolResult) {
            const finalMsg: any = { role: msg.role };
            if (finalContentParts.length > 0) {
              finalMsg.content = buildOpenAIContentFromParts(finalContentParts);
            }
            if (toolCalls.length > 0) {
              finalMsg.tool_calls = toolCalls;
              fillOpenAIMessageContent(finalMsg);
            }
            if (finalMsg.content !== undefined || finalMsg.tool_calls) {
              finalBody.messages.push(finalMsg);
            } else {
              finalBody.messages.push({ role: msg.role, content: "" });
            }
          } else if (finalContentParts.length > 0) {
            if (
              finalContentParts.length === 1 &&
              finalContentParts[0].type === "text"
            ) {
              finalBody.messages.push({
                role: msg.role,
                content: finalContentParts[0].text,
              });
            } else {
              finalBody.messages.push({
                role: msg.role,
                content: buildOpenAIContentFromParts(finalContentParts),
              });
            }
          }
        } else {
          finalBody.messages.push({
            role: msg.role,
            content:
              typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content || ""),
          });
        }
      }
    }

    if (systemTextParts.length > 0) {
      finalBody.messages.unshift({
        role: "system",
        content: systemTextParts.join("\n\n"),
      });
    }
  } else if (incomingProtocol === "openai" && !isAnthropicUpstream) {
    if (finalBody && Array.isArray(finalBody.messages)) {
      for (const msg of finalBody.messages) {
        sanitizeOpenAIMessageForUpstream(msg, requestPolicy);
        if (Array.isArray(msg.content)) {
          msg.content = normalizeOpenAIContentParts(msg.content, logInfo);
          msg.content = buildOpenAIContentFromParts(msg.content);
        }
        fillOpenAIMessageContent(msg);
      }
    }
  }

  if (logInfo.normalized) {
    logAction({
      ...baseActionLog,
      level: "INFO",
      code: "request.image_normalized",
      providerName: baseActionLog.providerName,
      modelId: modelId,
      message: `检测到多模态图片块，已规范化: ${JSON.stringify(logInfo.details)}`,
    });
  }

  if (finalBody && typeof finalBody === "object" && modelId) {
    finalBody.model = modelId;
  }

  if (incomingProtocol === "anthropic" && isAnthropicUpstream) {
    finalBody = applyAnthropicCompatibleOutbound(
      finalBody,
      outbound,
      (finalBody && finalBody.model) || modelId,
    );
  }

  return { finalBody, logInfo };
}

/**
 * Convert an OpenAI-format non-streaming response into Anthropic message
 * format.  Only called when the inbound request used Anthropic protocol but
 * the upstream is OpenAI-compatible.
 */
export function adaptNonStreamResponse(
  data: any,
  incomingProtocol: string,
  isAnthropicUpstream: boolean,
  modelId: string,
  promptTokens: number,
  completionTokens: number
): any {
  if (
    incomingProtocol !== "anthropic" ||
    isAnthropicUpstream
  ) {
    return data;
  }

  const msg = data.choices?.[0]?.message;
  let contentBlocks: any[] = [];
  if (msg?.content) {
    contentBlocks.push({ type: "text", text: msg.content });
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

  return anthropicRes;
}
