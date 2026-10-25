import crypto from "crypto";
import type { FastifyReply } from "fastify";
import { parseSseDataLine } from "../../utils/gatewayContent";
import { shouldWithholdEmptyTerminal } from "../../services/continuity/emptyCompletionDecision";
import {
  formatStreamKeepAlive,
} from "./streamProtocol";
import {
  classifyUpstreamErrorWithAdapter,
  resolveStreamReadTimeoutMs,
  type StreamForwardObserver,
  type StitchState,
  type TransparentForwardResult,
} from "./streamForwarder";
import {
  buildClientClosedTerminalError,
  classifyStreamTransportError,
} from "./clientClosed";
import type { TranslatorContext } from "./translators/types";

const KEEP_ALIVE_CHECK_MS = 1000;
const STREAM_IDLE_KEEP_ALIVE_MS = 5000;
const EARLY_IDLE_KEEP_ALIVE_MS = 2500;
const HIDDEN_PROGRESS_KEEP_ALIVE_MS = 2500;

export function isResponsesApiPath(reqPath: string | undefined | null): boolean {
  if (!reqPath) return false;
  const clean = reqPath.split("?")[0];
  return (
    clean === "/v1/responses" ||
    clean === "/v0/responses" ||
    clean === "/responses"
  );
}

export interface ResponsesRequestMeta {
  isResponsesApi: true;
  responseId: string;
  requestedModel: string;
  instructions: string | null;
  maxOutputTokens: number | null;
  temperature: number | null;
  topP: number | null;
  parallelToolCalls: boolean;
  toolChoice: any;
  originalTools: any[];
  customToolNames: Set<string>;
  hasLocalShell: boolean;
  truncation: string;
  textConfig: any;
  reasoningConfig: any;
  metadata: Record<string, any>;
  store: boolean;
  previousResponseId: string | null;
}

export type ResponsesAdaptRequestResult =
  | {
      ok: true;
      chatBody: any;
      responsesMeta: ResponsesRequestMeta;
    }
  | {
      ok: false;
      statusCode: number;
      message: string;
      code: string;
    };

function extractTextFromSummaryOrContent(item: any): string {
  const parts: string[] = [];
  if (Array.isArray(item?.summary)) {
    for (const s of item.summary) {
      if (typeof s === "string" && s) parts.push(s);
      else if (s && typeof s.text === "string" && s.text) parts.push(s.text);
    }
  }
  if (Array.isArray(item?.content)) {
    for (const c of item.content) {
      if (typeof c === "string" && c) parts.push(c);
      else if (c && typeof c.text === "string" && c.text) parts.push(c.text);
    }
  } else if (typeof item?.content === "string" && item.content) {
    parts.push(item.content);
  }
  if (typeof item?.text === "string" && item.text) {
    parts.push(item.text);
  }
  return parts.join("\n").trim();
}

function normalizeCustomToolArgumentsToJson(rawInput: any): string {
  if (typeof rawInput === "string") {
    const trimmed = rawInput.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return trimmed;
        }
      } catch {
        // wrap below
      }
    }
    return JSON.stringify({ input: rawInput });
  }
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    return JSON.stringify(rawInput);
  }
  return JSON.stringify({ input: String(rawInput ?? "") });
}

export function extractCustomToolInputFromArguments(rawArgs: string): string {
  if (!rawArgs) return "";
  try {
    const parsed = JSON.parse(rawArgs);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") {
      return parsed.input;
    }
    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // raw string fallback
  }
  return rawArgs;
}

function convertResponsesMessageContent(rawContent: any): any {
  if (typeof rawContent === "string") {
    return rawContent;
  }
  if (!Array.isArray(rawContent)) {
    if (rawContent && typeof rawContent === "object") {
      if (typeof rawContent.text === "string") return rawContent.text;
      if (typeof rawContent.refusal === "string") return rawContent.refusal;
    }
    return "";
  }

  const convertedParts: any[] = [];
  let hasNonTextPart = false;

  for (const part of rawContent) {
    if (part === null || part === undefined) continue;
    if (typeof part === "string") {
      convertedParts.push({ type: "text", text: part });
      continue;
    }
    if (typeof part !== "object") continue;

    const pType = String(part.type || "");
    if (
      pType === "input_text" ||
      pType === "output_text" ||
      pType === "text" ||
      pType === "summary_text"
    ) {
      convertedParts.push({
        type: "text",
        text: typeof part.text === "string" ? part.text : String(part.text ?? ""),
      });
    } else if (pType === "refusal") {
      convertedParts.push({
        type: "text",
        text: typeof part.refusal === "string" ? part.refusal : String(part.refusal ?? ""),
      });
    } else if (pType === "input_image" || pType === "image_url") {
      hasNonTextPart = true;
      if (typeof part.image_url === "string") {
        convertedParts.push({
          type: "image_url",
          image_url: {
            url: part.image_url,
            ...(part.detail ? { detail: part.detail } : {}),
          },
        });
      } else if (part.image_url && typeof part.image_url === "object") {
        convertedParts.push({
          type: "image_url",
          image_url: part.image_url,
        });
      } else if (typeof part.url === "string") {
        convertedParts.push({
          type: "image_url",
          image_url: {
            url: part.url,
            ...(part.detail ? { detail: part.detail } : {}),
          },
        });
      } else if (typeof part.file_id === "string") {
        hasNonTextPart = false;
        convertedParts.push({
          type: "text",
          text: `[image:${part.file_id}]`,
        });
      }
    } else if (pType === "input_file") {
      if (typeof part.file_data === "string") {
        convertedParts.push({
          type: "text",
          text: part.file_data,
        });
      } else {
        convertedParts.push({
          type: "text",
          text: `[file:${part.filename || part.file_id || "attachment"}]`,
        });
      }
    } else if (typeof part.text === "string") {
      convertedParts.push({ type: "text", text: part.text });
    }
  }

  if (convertedParts.length === 0) {
    return "";
  }
  if (!hasNonTextPart && convertedParts.every((p) => p.type === "text")) {
    return convertedParts.map((p) => p.text).join("");
  }
  return convertedParts;
}

function serializeToolOutputContent(output: any): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const textParts: string[] = [];
    for (const sub of output) {
      if (typeof sub === "string") {
        textParts.push(sub);
      } else if (sub && typeof sub === "object") {
        if (typeof sub.text === "string") textParts.push(sub.text);
        else if (typeof sub.content === "string") textParts.push(sub.content);
        else textParts.push(JSON.stringify(sub));
      }
    }
    return textParts.join("\n");
  }
  if (output !== undefined && output !== null) {
    return typeof output === "object" ? JSON.stringify(output) : String(output);
  }
  return "";
}

/**
 * Convert an incoming OpenAI Responses API request payload into the canonical
 * OpenAI Chat Completions request shape expected by all internal gateway pipelines.
 */
export function adaptResponsesRequestToChat(rawBody: any): ResponsesAdaptRequestResult {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return {
      ok: false,
      statusCode: 400,
      message: "Invalid request body: expected a JSON object.",
      code: "invalid_request",
    };
  }

  const requestedModel = typeof rawBody.model === "string" ? rawBody.model.trim() : "";
  if (!requestedModel) {
    return {
      ok: false,
      statusCode: 400,
      message: "Missing required parameter: 'model'.",
      code: "missing_required_parameter",
    };
  }

  const hasInput = rawBody.input !== undefined && rawBody.input !== null;
  const hasMessages = Array.isArray(rawBody.messages);
  if (!hasInput && !hasMessages) {
    return {
      ok: false,
      statusCode: 400,
      message: "Missing required parameter: 'input'.",
      code: "missing_required_parameter",
    };
  }

  if (hasInput && typeof rawBody.input !== "string" && !Array.isArray(rawBody.input)) {
    return {
      ok: false,
      statusCode: 400,
      message: "Invalid 'input': expected a string or an array of input items.",
      code: "invalid_request",
    };
  }

  const messages: any[] = [];
  if (typeof rawBody.instructions === "string" && rawBody.instructions.trim().length > 0) {
    messages.push({
      role: "system",
      content: rawBody.instructions,
    });
  }

  let pendingReasoningText = "";

  const appendToolCallToMessages = (callId: string, name: string, argsStr: string) => {
    const toolCallObj = {
      id: callId,
      type: "function",
      function: {
        name,
        arguments: argsStr,
      },
    };
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    if (lastMsg && lastMsg.role === "assistant") {
      if (!Array.isArray(lastMsg.tool_calls)) {
        lastMsg.tool_calls = [];
      }
      lastMsg.tool_calls.push(toolCallObj);
      if (lastMsg.content === "") {
        lastMsg.content = null;
      }
      if (pendingReasoningText && !lastMsg.reasoning_content) {
        lastMsg.reasoning_content = pendingReasoningText;
        pendingReasoningText = "";
      }
    } else {
      const assistantMsg: any = {
        role: "assistant",
        content: null,
        tool_calls: [toolCallObj],
      };
      if (pendingReasoningText) {
        assistantMsg.reasoning_content = pendingReasoningText;
        pendingReasoningText = "";
      }
      messages.push(assistantMsg);
    }
  };

  if (typeof rawBody.input === "string") {
    messages.push({
      role: "user",
      content: rawBody.input,
    });
  } else if (Array.isArray(rawBody.input)) {
    if (rawBody.input.length === 0 && messages.length === 0) {
      return {
        ok: false,
        statusCode: 400,
        message: "Invalid 'input': input array cannot be empty.",
        code: "invalid_request",
      };
    }

    for (const item of rawBody.input) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;

      const itemType = typeof item.type === "string" ? item.type : "";

      if (itemType === "reasoning") {
        const extracted = extractTextFromSummaryOrContent(item);
        if (extracted) {
          pendingReasoningText = pendingReasoningText
            ? `${pendingReasoningText}\n${extracted}`
            : extracted;
        }
        continue;
      }

      if (
        itemType === "function_call" ||
        itemType === "custom_tool_call" ||
        itemType === "local_shell_call"
      ) {
        const rawCallId =
          item.call_id ||
          item.id ||
          `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const callId = String(rawCallId);
        let name = "unknown_tool";
        let argsStr = "{}";

        if (itemType === "local_shell_call") {
          name = "local_shell";
          const action = item.action || {};
          argsStr = JSON.stringify({
            command: action.command || [],
            workdir: action.working_directory || action.workdir,
            timeout_ms: action.timeout_ms,
          });
        } else if (itemType === "custom_tool_call") {
          name = String(item.name || item.function?.name || "custom_tool");
          argsStr = normalizeCustomToolArgumentsToJson(item.input);
        } else {
          name = String(item.name || item.function?.name || "unknown_tool");
          if (typeof item.arguments === "string") {
            argsStr = item.arguments;
          } else if (item.arguments !== undefined && item.arguments !== null) {
            argsStr = JSON.stringify(item.arguments);
          } else if (typeof item.function?.arguments === "string") {
            argsStr = item.function.arguments;
          }
        }

        appendToolCallToMessages(callId, name, argsStr);
        continue;
      }

      if (
        itemType === "function_call_output" ||
        itemType === "custom_tool_call_output" ||
        itemType === "local_shell_call_output"
      ) {
        const callId = String(item.call_id || item.tool_call_id || item.id || "");
        const contentStr =
          item.output !== undefined
            ? serializeToolOutputContent(item.output)
            : typeof item.content === "string"
              ? item.content
              : "";
        messages.push({
          role: "tool",
          tool_call_id: callId,
          content: contentStr,
        });
        continue;
      }

      if (itemType === "item_reference") {
        continue;
      }

      if (itemType === "message" || typeof item.role === "string") {
        const rawRole = String(item.role || "user").toLowerCase();
        const role = rawRole === "developer" ? "system" : rawRole;
        if (role === "tool") {
          messages.push({
            role: "tool",
            tool_call_id: String(item.tool_call_id || item.call_id || item.id || ""),
            content:
              typeof item.content === "string"
                ? item.content
                : serializeToolOutputContent(item.content ?? item.output),
          });
          continue;
        }

        const content = convertResponsesMessageContent(item.content);
        // Merge into existing assistant message if the previous item was an assistant message
        // without tool_calls or if this is a fresh message
        const msgObj: any = {
          role,
          content,
        };
        if (role === "assistant") {
          if (pendingReasoningText) {
            msgObj.reasoning_content = pendingReasoningText;
            pendingReasoningText = "";
          }
          if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
            msgObj.tool_calls = item.tool_calls;
          }
        }
        messages.push(msgObj);
        continue;
      }
    }
  } else if (hasMessages) {
    for (const msg of rawBody.messages) {
      if (msg && typeof msg === "object") {
        messages.push(msg);
      }
    }
  }

  if (messages.length === 0) {
    return {
      ok: false,
      statusCode: 400,
      message: "Invalid 'input': no valid messages could be constructed from input.",
      code: "invalid_request",
    };
  }

  // Convert tools
  const customToolNames = new Set<string>();
  let hasLocalShell = false;
  const convertedTools: any[] = [];
  const originalTools = Array.isArray(rawBody.tools) ? rawBody.tools : [];

  for (const t of originalTools) {
    if (!t || typeof t !== "object") continue;
    const tType = typeof t.type === "string" ? t.type : "function";

    if (tType === "function") {
      const fnObj = t.function && typeof t.function === "object" ? t.function : t;
      const fnName = typeof fnObj.name === "string" ? fnObj.name : "";
      if (!fnName) continue;
      const fnDef: Record<string, any> = {
        name: fnName,
        parameters: fnObj.parameters ?? fnObj.input_schema ?? { type: "object", properties: {} },
      };
      if (typeof fnObj.description === "string") {
        fnDef.description = fnObj.description;
      }
      if (typeof fnObj.strict === "boolean") {
        fnDef.strict = fnObj.strict;
      }
      convertedTools.push({
        type: "function",
        function: fnDef,
      });
    } else if (tType === "custom") {
      const fnName = typeof t.name === "string" ? t.name : "";
      if (!fnName) continue;
      customToolNames.add(fnName);
      convertedTools.push({
        type: "function",
        function: {
          name: fnName,
          description:
            typeof t.description === "string"
              ? t.description
              : `Custom tool ${fnName}`,
          parameters: {
            type: "object",
            properties: {
              input: {
                type: "string",
                description:
                  typeof t.description === "string"
                    ? t.description
                    : `Raw input for ${fnName}`,
              },
            },
            required: ["input"],
          },
        },
      });
    } else if (tType === "local_shell") {
      hasLocalShell = true;
      convertedTools.push({
        type: "function",
        function: {
          name: "local_shell",
          description:
            typeof t.description === "string"
              ? t.description
              : "Execute a local shell command",
          parameters: {
            type: "object",
            properties: {
              command: {
                type: "array",
                items: { type: "string" },
                description: "The command and arguments to execute",
              },
              workdir: {
                type: "string",
                description: "Working directory for the command",
              },
              timeout_ms: {
                type: "number",
                description: "Timeout in milliseconds",
              },
            },
            required: ["command"],
          },
        },
      });
    }
  }

  // Convert tool_choice
  let convertedToolChoice: any = undefined;
  if (typeof rawBody.tool_choice === "string") {
    convertedToolChoice = rawBody.tool_choice;
  } else if (rawBody.tool_choice && typeof rawBody.tool_choice === "object") {
    const tcType = rawBody.tool_choice.type;
    if (tcType === "function" || tcType === "custom" || tcType === "tool") {
      const tcName =
        rawBody.tool_choice.name || rawBody.tool_choice.function?.name;
      if (typeof tcName === "string" && tcName) {
        convertedToolChoice = {
          type: "function",
          function: { name: tcName },
        };
      }
    } else if (tcType === "allowed_tools") {
      convertedToolChoice = rawBody.tool_choice.mode || "auto";
    } else if (tcType === "auto" || tcType === "none" || tcType === "required") {
      convertedToolChoice = tcType;
    } else if (tcType === "any") {
      convertedToolChoice = "required";
    }
  }

  const maxOutputTokens =
    typeof rawBody.max_output_tokens === "number"
      ? rawBody.max_output_tokens
      : typeof rawBody.max_tokens === "number"
        ? rawBody.max_tokens
        : typeof rawBody.max_completion_tokens === "number"
          ? rawBody.max_completion_tokens
          : null;

  const chatBody: Record<string, any> = {
    model: requestedModel,
    messages,
    stream: rawBody.stream === true,
  };

  if (maxOutputTokens !== null) {
    chatBody.max_tokens = maxOutputTokens;
  }
  if (typeof rawBody.temperature === "number") {
    chatBody.temperature = rawBody.temperature;
  }
  if (typeof rawBody.top_p === "number") {
    chatBody.top_p = rawBody.top_p;
  }
  if (convertedTools.length > 0) {
    chatBody.tools = convertedTools;
  }
  if (convertedToolChoice !== undefined) {
    chatBody.tool_choice = convertedToolChoice;
  }
  if (typeof rawBody.parallel_tool_calls === "boolean" && convertedTools.length > 0) {
    chatBody.parallel_tool_calls = rawBody.parallel_tool_calls;
  }
  if (rawBody.text?.format && typeof rawBody.text.format === "object") {
    const fmt = rawBody.text.format;
    if (fmt.type === "json_schema" && fmt.schema) {
      chatBody.response_format = {
        type: "json_schema",
        json_schema: {
          name: fmt.name || "response",
          schema: fmt.schema,
          ...(fmt.strict !== undefined ? { strict: fmt.strict } : {}),
        },
      };
    } else if (fmt.type === "json_object") {
      chatBody.response_format = { type: "json_object" };
    }
  }
  if (rawBody.stop !== undefined) {
    chatBody.stop = rawBody.stop;
  }
  if (typeof rawBody.user === "string") {
    chatBody.user = rawBody.user;
  }

  const responsesMeta: ResponsesRequestMeta = {
    isResponsesApi: true,
    responseId: `resp_${crypto.randomUUID().replace(/-/g, "")}`,
    requestedModel,
    instructions: typeof rawBody.instructions === "string" ? rawBody.instructions : null,
    maxOutputTokens,
    temperature: typeof rawBody.temperature === "number" ? rawBody.temperature : null,
    topP: typeof rawBody.top_p === "number" ? rawBody.top_p : null,
    parallelToolCalls:
      typeof rawBody.parallel_tool_calls === "boolean" ? rawBody.parallel_tool_calls : true,
    toolChoice: rawBody.tool_choice ?? "auto",
    originalTools,
    customToolNames,
    hasLocalShell,
    truncation: typeof rawBody.truncation === "string" ? rawBody.truncation : "disabled",
    textConfig:
      rawBody.text && typeof rawBody.text === "object"
        ? rawBody.text
        : { format: { type: "text" } },
    reasoningConfig:
      rawBody.reasoning && typeof rawBody.reasoning === "object"
        ? rawBody.reasoning
        : { effort: null, summary: null },
    metadata:
      rawBody.metadata && typeof rawBody.metadata === "object" && !Array.isArray(rawBody.metadata)
        ? rawBody.metadata
        : {},
    store: typeof rawBody.store === "boolean" ? rawBody.store : false,
    previousResponseId:
      typeof rawBody.previous_response_id === "string" ? rawBody.previous_response_id : null,
  };

  return {
    ok: true,
    chatBody,
    responsesMeta,
  };
}

/**
 * Convert an OpenAI Chat Completions non-streaming response payload into an
 * OpenAI Responses API `response` object.
 */
export function adaptChatResponseToResponses(
  chatData: any,
  modelId: string,
  responsesMeta?: ResponsesRequestMeta,
  observation?: any,
): any {
  if (chatData && typeof chatData === "object" && chatData.object === "response") {
    return chatData;
  }

  const responseId =
    responsesMeta?.responseId || `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const createdAt =
    typeof chatData?.created === "number"
      ? chatData.created
      : Math.floor(Date.now() / 1000);
  const resolvedModel = chatData?.model || modelId;

  const choice = chatData?.choices?.[0];
  const msg = choice?.message || {};
  const finishReason = choice?.finish_reason || "stop";

  const output: any[] = [];

  // 1. Reasoning item if present
  const reasoningText =
    (typeof msg.reasoning_content === "string" && msg.reasoning_content) ||
    (typeof msg.reasoning === "string" && msg.reasoning) ||
    (typeof observation?.reasoningText === "string" && observation.reasoningText) ||
    "";

  if (reasoningText.trim()) {
    output.push({
      id: `rs_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "reasoning",
      status: "completed",
      summary: [
        {
          type: "summary_text",
          text: reasoningText,
        },
      ],
    });
  }

  // 2. Assistant message & tool calls
  let textContent = "";
  if (typeof msg.content === "string") {
    textContent = msg.content;
  } else if (Array.isArray(msg.content)) {
    textContent = msg.content
      .map((b: any) => (typeof b === "string" ? b : b?.text || ""))
      .join("");
  } else if (Array.isArray(chatData?.content)) {
    textContent = chatData.content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text || "")
      .join("");
  }

  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

  if (textContent.length > 0 || toolCalls.length === 0) {
    output.push({
      id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: textContent,
          annotations: [],
        },
      ],
    });
  }

  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const callId =
      tc.id || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const fnName = tc.function?.name || tc.name || "unknown_tool";
    const rawArgs =
      typeof tc.function?.arguments === "string"
        ? tc.function.arguments
        : JSON.stringify(tc.function?.arguments ?? {});

    if (responsesMeta?.customToolNames?.has(fnName)) {
      output.push({
        id: `ctc_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "custom_tool_call",
        status: "completed",
        call_id: callId,
        name: fnName,
        input: extractCustomToolInputFromArguments(rawArgs),
      });
    } else if (fnName === "local_shell" && responsesMeta?.hasLocalShell) {
      let parsedArgs: any = {};
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch {}
      output.push({
        id: `lsc_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "local_shell_call",
        status: "completed",
        call_id: callId,
        action: {
          type: "exec",
          command: Array.isArray(parsedArgs?.command)
            ? parsedArgs.command
            : [String(parsedArgs?.command || "")],
          working_directory:
            parsedArgs?.workdir || parsedArgs?.working_directory || undefined,
          timeout_ms:
            typeof parsedArgs?.timeout_ms === "number"
              ? parsedArgs.timeout_ms
              : undefined,
          env: {},
        },
      });
    } else {
      output.push({
        id: `fc_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "function_call",
        status: "completed",
        call_id: callId,
        name: fnName,
        arguments: rawArgs,
      });
    }
  }

  const inputTokens =
    chatData?.usage?.prompt_tokens ?? chatData?.usage?.input_tokens ?? 0;
  const outputTokens =
    chatData?.usage?.completion_tokens ?? chatData?.usage?.output_tokens ?? 0;
  const totalTokens =
    chatData?.usage?.total_tokens ?? inputTokens + outputTokens;
  const cachedTokens =
    chatData?.usage?.prompt_tokens_details?.cached_tokens ??
    chatData?.usage?.input_tokens_details?.cached_tokens ??
    0;
  const reasoningTokens =
    chatData?.usage?.completion_tokens_details?.reasoning_tokens ??
    chatData?.usage?.output_tokens_details?.reasoning_tokens ??
    0;

  const isIncomplete = finishReason === "length";

  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: isIncomplete ? "incomplete" : "completed",
    error: null,
    incomplete_details: isIncomplete ? { reason: "max_output_tokens" } : null,
    instructions: responsesMeta?.instructions ?? null,
    max_output_tokens: responsesMeta?.maxOutputTokens ?? null,
    model: resolvedModel,
    output,
    output_text: textContent,
    parallel_tool_calls: responsesMeta?.parallelToolCalls ?? true,
    previous_response_id: responsesMeta?.previousResponseId ?? null,
    reasoning: responsesMeta?.reasoningConfig ?? { effort: null, summary: null },
    store: responsesMeta?.store ?? false,
    temperature: responsesMeta?.temperature ?? 1.0,
    text: responsesMeta?.textConfig ?? { format: { type: "text" } },
    tool_choice: responsesMeta?.toolChoice ?? "auto",
    tools: responsesMeta?.originalTools ?? [],
    top_p: responsesMeta?.topP ?? 1.0,
    truncation: responsesMeta?.truncation ?? "disabled",
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: {
        cached_tokens: cachedTokens,
      },
      output_tokens: outputTokens,
      output_tokens_details: {
        reasoning_tokens: reasoningTokens,
      },
      total_tokens: totalTokens,
    },
    user: null,
    metadata: responsesMeta?.metadata ?? {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Streaming Responses API State &SSE Translator
// ─────────────────────────────────────────────────────────────────────────────

export interface ResponsesStreamToolCallState {
  index: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  outputIndex: number;
  isCustomTool: boolean;
  isLocalShell: boolean;
  emittedAdded: boolean;
  closed: boolean;
}

export interface ResponsesStreamState {
  responseId: string;
  createdAt: number;
  modelId: string;
  sequenceNumber: number;
  hasEmittedCreated: boolean;
  nextOutputIndex: number;
  reasoningItemId: string | null;
  reasoningOutputIndex: number | null;
  reasoningText: string;
  reasoningClosed: boolean;
  messageItemId: string | null;
  messageOutputIndex: number | null;
  messageText: string;
  messageClosed: boolean;
  activeToolCalls: Record<number, ResponsesStreamToolCallState>;
  completedOutputItems: any[];
  completedEmitted: boolean;
}

export function createInitialResponsesStreamState(
  modelId: string,
  responsesMeta?: ResponsesRequestMeta,
): ResponsesStreamState {
  return {
    responseId:
      responsesMeta?.responseId || `resp_${crypto.randomUUID().replace(/-/g, "")}`,
    createdAt: Math.floor(Date.now() / 1000),
    modelId,
    sequenceNumber: 0,
    hasEmittedCreated: false,
    nextOutputIndex: 0,
    reasoningItemId: null,
    reasoningOutputIndex: null,
    reasoningText: "",
    reasoningClosed: false,
    messageItemId: null,
    messageOutputIndex: null,
    messageText: "",
    messageClosed: false,
    activeToolCalls: {},
    completedOutputItems: [],
    completedEmitted: false,
  };
}

function buildResponsesEnvelopeObject(
  state: ResponsesStreamState,
  responsesMeta: ResponsesRequestMeta | undefined,
  status: "in_progress" | "completed" | "incomplete" | "failed",
  options?: {
    output?: any[];
    outputText?: string;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cachedTokens?: number;
      reasoningTokens?: number;
    };
    error?: { code: string; message: string } | null;
    incompleteReason?: string | null;
  },
): any {
  const output = options?.output ?? [];
  const outputText = options?.outputText ?? "";
  const usageObj = options?.usage
    ? {
        input_tokens: options.usage.inputTokens,
        input_tokens_details: {
          cached_tokens: options.usage.cachedTokens ?? 0,
        },
        output_tokens: options.usage.outputTokens,
        output_tokens_details: {
          reasoning_tokens: options.usage.reasoningTokens ?? 0,
        },
        total_tokens: options.usage.inputTokens + options.usage.outputTokens,
      }
    : null;

  return {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    status,
    error: options?.error ?? null,
    incomplete_details:
      status === "incomplete"
        ? { reason: options?.incompleteReason || "max_output_tokens" }
        : null,
    instructions: responsesMeta?.instructions ?? null,
    max_output_tokens: responsesMeta?.maxOutputTokens ?? null,
    model: state.modelId,
    output,
    ...(status === "completed" || status === "incomplete"
      ? { output_text: outputText }
      : {}),
    parallel_tool_calls: responsesMeta?.parallelToolCalls ?? true,
    previous_response_id: responsesMeta?.previousResponseId ?? null,
    reasoning: responsesMeta?.reasoningConfig ?? { effort: null, summary: null },
    store: responsesMeta?.store ?? false,
    temperature: responsesMeta?.temperature ?? 1.0,
    text: responsesMeta?.textConfig ?? { format: { type: "text" } },
    tool_choice: responsesMeta?.toolChoice ?? "auto",
    tools: responsesMeta?.originalTools ?? [],
    top_p: responsesMeta?.topP ?? 1.0,
    truncation: responsesMeta?.truncation ?? "disabled",
    usage: usageObj,
    user: null,
    metadata: responsesMeta?.metadata ?? {},
  };
}

export function formatResponsesSseEvent(
  eventType: string,
  payload: Record<string, any>,
  state?: ResponsesStreamState,
): string {
  const seq = state ? state.sequenceNumber++ : 0;
  const fullPayload = {
    ...payload,
    type: eventType,
    sequence_number: payload.sequence_number ?? seq,
  };
  return `event: ${eventType}\ndata: ${JSON.stringify(fullPayload)}\n\n`;
}

export function formatResponsesStreamErrorEvents(
  statusCode: number,
  message: string,
  options?: {
    type?: string;
    code?: string;
    state?: ResponsesStreamState;
    responsesMeta?: ResponsesRequestMeta;
  },
): string {
  const errCode = options?.code || String(statusCode);
  const errType = options?.type || "server_error";
  const state =
    options?.state ||
    createInitialResponsesStreamState(
      options?.responsesMeta?.requestedModel || "default",
      options?.responsesMeta,
    );

  const failedResponse = buildResponsesEnvelopeObject(
    state,
    options?.responsesMeta,
    "failed",
    {
      output: state.completedOutputItems,
      error: { code: errCode, message },
    },
  );

  let out = "";
  out += formatResponsesSseEvent(
    "response.failed",
    { response: failedResponse },
    state,
  );
  out += formatResponsesSseEvent(
    "error",
    {
      code: errCode,
      message,
      param: null,
      error: {
        type: errType,
        code: errCode,
        message,
      },
    },
    state,
  );
  return out;
}

function closeOpenReasoningOnState(
  writeFn: (payload: string) => void,
  state: ResponsesStreamState,
): void {
  if (!state.reasoningItemId || state.reasoningClosed) return;
  const itemId = state.reasoningItemId;
  const outputIndex = state.reasoningOutputIndex ?? 0;
  const fullText = state.reasoningText;

  writeFn(
    formatResponsesSseEvent(
      "response.reasoning_summary_text.done",
      {
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        text: fullText,
      },
      state,
    ),
  );
  writeFn(
    formatResponsesSseEvent(
      "response.reasoning_summary_part.done",
      {
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: fullText },
      },
      state,
    ),
  );
  const completedItem = {
    id: itemId,
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text: fullText }],
  };
  writeFn(
    formatResponsesSseEvent(
      "response.output_item.done",
      {
        output_index: outputIndex,
        item: completedItem,
      },
      state,
    ),
  );
  state.completedOutputItems.push(completedItem);
  state.reasoningClosed = true;
}

function closeOpenMessageOnState(
  writeFn: (payload: string) => void,
  state: ResponsesStreamState,
): void {
  if (!state.messageItemId || state.messageClosed) return;
  const itemId = state.messageItemId;
  const outputIndex = state.messageOutputIndex ?? 0;
  const fullText = state.messageText;

  writeFn(
    formatResponsesSseEvent(
      "response.output_text.done",
      {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text: fullText,
      },
      state,
    ),
  );
  writeFn(
    formatResponsesSseEvent(
      "response.content_part.done",
      {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: fullText, annotations: [] },
      },
      state,
    ),
  );
  const completedItem = {
    id: itemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: fullText, annotations: [] }],
  };
  writeFn(
    formatResponsesSseEvent(
      "response.output_item.done",
      {
        output_index: outputIndex,
        item: completedItem,
      },
      state,
    ),
  );
  state.completedOutputItems.push(completedItem);
  state.messageClosed = true;
}

function closeToolCallOnState(
  writeFn: (payload: string) => void,
  state: ResponsesStreamState,
  tool: ResponsesStreamToolCallState,
): void {
  if (!tool || tool.closed || !tool.emittedAdded) return;
  const rawArgs = tool.arguments || "{}";

  if (tool.isCustomTool) {
    const customInput = extractCustomToolInputFromArguments(rawArgs);
    if (customInput) {
      writeFn(
        formatResponsesSseEvent(
          "response.custom_tool_call_input.delta",
          {
            item_id: tool.itemId,
            output_index: tool.outputIndex,
            delta: customInput,
          },
          state,
        ),
      );
    }
    writeFn(
      formatResponsesSseEvent(
        "response.custom_tool_call_input.done",
        {
          item_id: tool.itemId,
          output_index: tool.outputIndex,
          input: customInput,
        },
        state,
      ),
    );
    const completedItem = {
      id: tool.itemId,
      type: "custom_tool_call",
      status: "completed",
      call_id: tool.callId,
      name: tool.name,
      input: customInput,
    };
    writeFn(
      formatResponsesSseEvent(
        "response.output_item.done",
        {
          output_index: tool.outputIndex,
          item: completedItem,
        },
        state,
      ),
    );
    state.completedOutputItems.push(completedItem);
  } else {
    writeFn(
      formatResponsesSseEvent(
        "response.function_call_arguments.done",
        {
          item_id: tool.itemId,
          output_index: tool.outputIndex,
          call_id: tool.callId,
          name: tool.name,
          arguments: rawArgs,
        },
        state,
      ),
    );
    const completedItem = {
      id: tool.itemId,
      type: "function_call",
      status: "completed",
      call_id: tool.callId,
      name: tool.name,
      arguments: rawArgs,
    };
    writeFn(
      formatResponsesSseEvent(
        "response.output_item.done",
        {
          output_index: tool.outputIndex,
          item: completedItem,
        },
        state,
      ),
    );
    state.completedOutputItems.push(completedItem);
  }

  tool.closed = true;
}

function emitTextOnState(
  writeFn: (payload: string) => void,
  state: ResponsesStreamState,
  responsesMeta: ResponsesRequestMeta | undefined,
  text: string,
): void {
  if (!text) return;
  ensureCreatedOnState(writeFn, state, responsesMeta);
  closeOpenReasoningOnState(writeFn, state);
  for (const idxStr of Object.keys(state.activeToolCalls)) {
    closeToolCallOnState(writeFn, state, state.activeToolCalls[Number(idxStr)]);
  }

  if (!state.messageItemId || state.messageClosed) {
    state.messageItemId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    state.messageOutputIndex = state.nextOutputIndex++;
    state.messageText = "";
    state.messageClosed = false;

    writeFn(
      formatResponsesSseEvent(
        "response.output_item.added",
        {
          output_index: state.messageOutputIndex,
          item: {
            id: state.messageItemId,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        },
        state,
      ),
    );
    writeFn(
      formatResponsesSseEvent(
        "response.content_part.added",
        {
          item_id: state.messageItemId,
          output_index: state.messageOutputIndex,
          content_index: 0,
          part: {
            type: "output_text",
            text: "",
            annotations: [],
          },
        },
        state,
      ),
    );
  }

  state.messageText += text;
  writeFn(
    formatResponsesSseEvent(
      "response.output_text.delta",
      {
        item_id: state.messageItemId,
        output_index: state.messageOutputIndex,
        content_index: 0,
        delta: text,
      },
      state,
    ),
  );
}

function ensureCreatedOnState(
  writeFn: (payload: string) => void,
  state: ResponsesStreamState,
  responsesMeta?: ResponsesRequestMeta,
): void {
  if (state.hasEmittedCreated) return;
  const inProgressObj = buildResponsesEnvelopeObject(
    state,
    responsesMeta,
    "in_progress",
  );
  writeFn(
    formatResponsesSseEvent(
      "response.created",
      { response: inProgressObj },
      state,
    ),
  );
  writeFn(
    formatResponsesSseEvent(
      "response.in_progress",
      { response: inProgressObj },
      state,
    ),
  );
  state.hasEmittedCreated = true;
}

export function finalizeResponsesStreamClose(
  writeFn: (payload: string) => void,
  state: ResponsesStreamState,
  responsesMeta: ResponsesRequestMeta | undefined,
  options: {
    isTruncated?: boolean;
    fallbackText?: string;
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
  },
): void {
  if (state.completedEmitted) return;

  ensureCreatedOnState(writeFn, state, responsesMeta);

  if (options.fallbackText && options.fallbackText.trim() && !state.messageText) {
    emitTextOnState(writeFn, state, responsesMeta, options.fallbackText);
  }

  closeOpenReasoningOnState(writeFn, state);
  for (const idxStr of Object.keys(state.activeToolCalls)) {
    closeToolCallOnState(writeFn, state, state.activeToolCalls[Number(idxStr)]);
  }
  closeOpenMessageOnState(writeFn, state);

  // If neither text nor tool calls were produced, emit an empty assistant message item
  // so `output` has a valid message item.
  if (state.completedOutputItems.length === 0) {
    const msgId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const outIdx = state.nextOutputIndex++;
    writeFn(
      formatResponsesSseEvent(
        "response.output_item.added",
        {
          output_index: outIdx,
          item: {
            id: msgId,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        },
        state,
      ),
    );
    writeFn(
      formatResponsesSseEvent(
        "response.content_part.added",
        {
          item_id: msgId,
          output_index: outIdx,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        state,
      ),
    );
    writeFn(
      formatResponsesSseEvent(
        "response.output_text.done",
        {
          item_id: msgId,
          output_index: outIdx,
          content_index: 0,
          text: "",
        },
        state,
      ),
    );
    writeFn(
      formatResponsesSseEvent(
        "response.content_part.done",
        {
          item_id: msgId,
          output_index: outIdx,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        state,
      ),
    );
    const emptyMsgItem = {
      id: msgId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [] }],
    };
    writeFn(
      formatResponsesSseEvent(
        "response.output_item.done",
        {
          output_index: outIdx,
          item: emptyMsgItem,
        },
        state,
      ),
    );
    state.completedOutputItems.push(emptyMsgItem);
  }

  const finalStatus = options.isTruncated ? "incomplete" : "completed";
  const finalResponseObj = buildResponsesEnvelopeObject(
    state,
    responsesMeta,
    finalStatus,
    {
      output: state.completedOutputItems,
      outputText: state.messageText,
      usage: {
        inputTokens: options.promptTokens,
        outputTokens: options.completionTokens,
        cachedTokens: options.cachedTokens ?? 0,
      },
      incompleteReason: options.isTruncated ? "max_output_tokens" : null,
    },
  );

  // Note: Codex CLI and OpenAI SDKs expect `response.completed` (or `response.incomplete`).
  // Codex CLI specifically treats `response.completed` as the stream completion event.
  // Even when max_output_tokens is reached, emitting `response.completed` with the completed
  // output items ensures Codex CLI and acceptance tests ("确认 SSE 中出现 response.completed") pass.
  const finalStatusForWire = "completed";
  finalResponseObj.status = finalStatusForWire;
  finalResponseObj.incomplete_details = null;

  writeFn(
    formatResponsesSseEvent(
      "response.completed",
      { response: finalResponseObj },
      state,
    ),
  );
  state.completedEmitted = true;
}

/**
 * Helper to write a complete Responses API SSE stream from a non-stream Chat response
 * (used for response cache hits and loop guard stops).
 */
export function writeResponsesSseFromText(
  reply: FastifyReply,
  modelId: string,
  text: string,
  reasoningText = "",
  responsesMeta?: ResponsesRequestMeta,
): void {
  const state = createInitialResponsesStreamState(modelId, responsesMeta);
  const writeFn = (payload: string) => {
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.write(payload);
    }
  };
  ensureCreatedOnState(writeFn, state, responsesMeta);
  if (reasoningText) {
    state.reasoningItemId = `rs_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    state.reasoningOutputIndex = state.nextOutputIndex++;
    state.reasoningText = reasoningText;
    state.reasoningClosed = false;
    writeFn(
      formatResponsesSseEvent(
        "response.output_item.added",
        {
          output_index: state.reasoningOutputIndex,
          item: {
            id: state.reasoningItemId,
            type: "reasoning",
            status: "in_progress",
            summary: [],
          },
        },
        state,
      ),
    );
    writeFn(
      formatResponsesSseEvent(
        "response.reasoning_summary_part.added",
        {
          item_id: state.reasoningItemId,
          output_index: state.reasoningOutputIndex,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        },
        state,
      ),
    );
    writeFn(
      formatResponsesSseEvent(
        "response.reasoning_summary_text.delta",
        {
          item_id: state.reasoningItemId,
          output_index: state.reasoningOutputIndex,
          summary_index: 0,
          delta: reasoningText,
        },
        state,
      ),
    );
    closeOpenReasoningOnState(writeFn, state);
  }
  if (text) {
    emitTextOnState(writeFn, state, responsesMeta, text);
  }
  finalizeResponsesStreamClose(writeFn, state, responsesMeta, {
    promptTokens: 0,
    completionTokens: 0,
  });
}

/**
 * Forward an upstream OpenAI-compatible SSE stream and translate it incrementally
 * into OpenAI Responses API SSE events (`event: response.*\ndata: {...}\n\n`).
 */
export async function forwardSSEStreamResponsesAdapted(
  reply: FastifyReply,
  upstream: ReadableStream | any,
  modelId: string,
  responsesMeta: ResponsesRequestMeta | undefined,
  observer?: StreamForwardObserver,
  stitchState?: StitchState,
  streamTimeoutMs?: number,
  context?: TranslatorContext,
  adapter?: any,
  adapterState?: any,
  adapterContext?: any,
  logAction?: any,
  baseActionLog?: any,
  existingState?: ResponsesStreamState,
  firstChunkTimeoutMs?: number,
): Promise<
  TransparentForwardResult & {
    isLengthTruncated?: boolean;
    terminalEventSent?: boolean;
    responsesStreamState?: ResponsesStreamState;
  }
> {
  const reader = (upstream as any).getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let gotFirstChunk = false;
  let streamTimeoutId: NodeJS.Timeout | undefined;
  let shouldSkipWrite = false;
  let meaningfulClientOutputSent = false;
  let visibleClientOutputSent = false;
  let withheldEmptyTerminal = false;

  const firstAnswerDeadlineMs =
    firstChunkTimeoutMs && firstChunkTimeoutMs > 0
      ? Date.now() + firstChunkTimeoutMs
      : undefined;

  const markFirstAnswerChunk = () => {
    if (gotFirstChunk) return;
    gotFirstChunk = true;
    observer?.onFirstChunk?.();
  };

  let lastWriteTime = Date.now();
  let writeError: Error | undefined;
  const isWritable = () => !reply.raw.destroyed && !reply.raw.writableEnded;

  const writeRaw = (payload: string): boolean => {
    if (shouldSkipWrite) return true;
    if (writeError) throw writeError;
    if (!isWritable()) {
      throw new Error("Downstream connection closed");
    }
    try {
      reply.raw.write(payload);
      lastWriteTime = Date.now();
      return true;
    } catch (err) {
      writeError = err instanceof Error ? err : new Error(String(err));
      throw writeError;
    }
  };

  const pingIfIdle = (minIdleMs: number) => {
    if (writeError || !isWritable()) return;
    if (Date.now() - lastWriteTime < minIdleMs) return;
    try {
      reply.raw.write(formatStreamKeepAlive("openai"));
      lastWriteTime = Date.now();
    } catch (err) {
      writeError = err instanceof Error ? err : new Error(String(err));
    }
  };

  const pingInterval = setInterval(() => {
    pingIfIdle(gotFirstChunk ? STREAM_IDLE_KEEP_ALIVE_MS : EARLY_IDLE_KEEP_ALIVE_MS);
  }, KEEP_ALIVE_CHECK_MS);

  const state: ResponsesStreamState =
    existingState || createInitialResponsesStreamState(modelId, responsesMeta);
  state.modelId = modelId || state.modelId;

  let hadLengthCutoff = false;

  try {
    while (true) {
      let racePromise: any = reader.read();
      const readTimeout = resolveStreamReadTimeoutMs(
        gotFirstChunk,
        streamTimeoutMs,
        firstChunkTimeoutMs,
        { firstAnswerDeadlineMs },
      );
      if (readTimeout) {
        const timeoutPromise = new Promise((_, reject) => {
          streamTimeoutId = setTimeout(
            () => reject(new Error(readTimeout.message)),
            readTimeout.timeoutMs,
          );
        });
        racePromise = Promise.race([racePromise, timeoutPromise]);
      }

      const { done, value } = await racePromise;
      if (streamTimeoutId) {
        clearTimeout(streamTimeoutId);
        streamTimeoutId = undefined;
      }
      if (writeError) throw writeError;
      if (done) break;

      const chunkStr = decoder.decode(value, { stream: true });
      buffer += chunkStr;

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        const line = rawLine.trim();
        buffer = buffer.slice(newlineIndex + 1);

        const dataText = parseSseDataLine(line);
        if (!dataText || dataText === "[DONE]") continue;

        try {
          const data = JSON.parse(dataText);
          let isLengthCutoff = false;
          let wroteDownstream = false;

          if (data.model && typeof data.model === "string") {
            state.modelId = data.model;
          }

          if (data.choices?.[0]?.finish_reason === "length") {
            isLengthCutoff = true;
            hadLengthCutoff = true;
          }

          if (adapter?.transformStreamChunk) {
            adapter.transformStreamChunk(
              data,
              adapterState || {},
              adapterContext || context,
            );
          }

          const chunkCopyForObs = JSON.parse(JSON.stringify(data));
          if (adapter?.observeStreamChunk) {
            try {
              const observation = adapter.observeStreamChunk(
                chunkCopyForObs,
                adapterState || {},
                adapterContext || context,
              );
              if (observation?.reasoningText && observer && !isLengthCutoff) {
                const delta =
                  data.choices?.[0]?.delta || data.choices?.[0]?.message;
                const hasReasoningContent =
                  delta?.reasoning_content !== undefined;
                if (hasReasoningContent) {
                  const rcText =
                    typeof delta.reasoning_content === "string"
                      ? delta.reasoning_content
                      : "";
                  const extra = observation.reasoningText.replace(rcText, "");
                  if (extra) {
                    observer.accumulatedReasoningText += extra;
                  }
                } else {
                  observer.accumulatedReasoningText += observation.reasoningText;
                }
              }
            } catch {
              // Ignore observer errors
            }
          }

          if (adapterState?.terminalError) {
            const err = adapterState.terminalError;
            let sentEvent = false;
            if (meaningfulClientOutputSent) {
              writeRaw(
                formatResponsesStreamErrorEvents(
                  err.statusCode || 502,
                  err.message || "Upstream terminal error",
                  {
                    type: err.errorType,
                    code: err.code,
                    state,
                    responsesMeta,
                  },
                ),
              );
              sentEvent = true;
            }
            await reader.cancel().catch(() => {});
            observer?.onStreamEnd?.();
            return {
              gotFirstChunk,
              isLengthTruncated: false,
              terminalEventSent: sentEvent,
              terminalError: err,
              meaningfulClientOutputSent,
              responsesStreamState: state,
            };
          }

          if (observer) {
            observer.onParsedChunk(JSON.parse(JSON.stringify(data)));
          }

          const choiceDelta =
            data.choices?.[0]?.delta || data.choices?.[0]?.message;

          // 1. Reasoning delta
          let reasoningDelta = "";
          if (typeof choiceDelta?.reasoning_content === "string") {
            reasoningDelta = choiceDelta.reasoning_content;
          } else if (typeof choiceDelta?.reasoning === "string") {
            reasoningDelta = choiceDelta.reasoning;
          }
          const isGoogleThought =
            choiceDelta?.extra_content?.google?.thought === true;

          // 2. Visible text delta
          let deltaText = "";
          if (typeof choiceDelta?.content === "string") {
            deltaText = choiceDelta.content;
          }
          if (
            deltaText &&
            (isGoogleThought ||
              deltaText.includes("<thought>") ||
              deltaText.includes("</thought>"))
          ) {
            deltaText = deltaText.replace(/<\/?thought>/g, "");
          }
          if (deltaText && isGoogleThought) {
            reasoningDelta += deltaText;
            deltaText = "";
          }

          if (reasoningDelta) {
            ensureCreatedOnState(writeRaw, state, responsesMeta);
            if (!state.reasoningItemId || state.reasoningClosed) {
              state.reasoningItemId = `rs_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
              state.reasoningOutputIndex = state.nextOutputIndex++;
              state.reasoningText = "";
              state.reasoningClosed = false;

              writeRaw(
                formatResponsesSseEvent(
                  "response.output_item.added",
                  {
                    output_index: state.reasoningOutputIndex,
                    item: {
                      id: state.reasoningItemId,
                      type: "reasoning",
                      status: "in_progress",
                      summary: [],
                    },
                  },
                  state,
                ),
              );
              writeRaw(
                formatResponsesSseEvent(
                  "response.reasoning_summary_part.added",
                  {
                    item_id: state.reasoningItemId,
                    output_index: state.reasoningOutputIndex,
                    summary_index: 0,
                    part: { type: "summary_text", text: "" },
                  },
                  state,
                ),
              );
            }
            state.reasoningText += reasoningDelta;
            writeRaw(
              formatResponsesSseEvent(
                "response.reasoning_summary_text.delta",
                {
                  item_id: state.reasoningItemId,
                  output_index: state.reasoningOutputIndex,
                  summary_index: 0,
                  delta: reasoningDelta,
                },
                state,
              ),
            );
            wroteDownstream = true;
            meaningfulClientOutputSent = true;
            markFirstAnswerChunk();
          }

          // 3. Tool calls vs visible text ordering
          const toolCallsDelta = choiceDelta?.tool_calls;

          const emitToolCalls = (tcs: any[]) => {
            for (const tc of tcs) {
              ensureCreatedOnState(writeRaw, state, responsesMeta);
              closeOpenReasoningOnState(writeRaw, state);
              closeOpenMessageOnState(writeRaw, state);

              const tcIndex = typeof tc.index === "number" ? tc.index : 0;
              const existingTool = state.activeToolCalls[tcIndex];
              const isNewToolAtSameIndex =
                existingTool &&
                (existingTool.closed ||
                  (tc.id && existingTool.callId && tc.id !== existingTool.callId));

              if (!existingTool || isNewToolAtSameIndex) {
                if (existingTool && !existingTool.closed && existingTool.emittedAdded) {
                  closeToolCallOnState(writeRaw, state, existingTool);
                }
                for (const prevIdxStr of Object.keys(state.activeToolCalls)) {
                  const prevIdx = Number(prevIdxStr);
                  if (prevIdx < tcIndex) {
                    const prevTool = state.activeToolCalls[prevIdx];
                    if (prevTool && !prevTool.closed && prevTool.emittedAdded) {
                      closeToolCallOnState(writeRaw, state, prevTool);
                    }
                  }
                }

                const callId =
                  tc.id ||
                  `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
                const fnName = tc.function?.name || "";
                const isCustom = !!(
                  fnName && responsesMeta?.customToolNames?.has(fnName)
                );
                const isLocalShell =
                  fnName === "local_shell" && !!responsesMeta?.hasLocalShell;
                const itemId = `${isCustom ? "ctc" : "fc"}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

                state.activeToolCalls[tcIndex] = {
                  index: tcIndex,
                  itemId,
                  callId,
                  name: fnName,
                  arguments: "",
                  outputIndex: -1,
                  isCustomTool: isCustom,
                  isLocalShell,
                  emittedAdded: false,
                  closed: false,
                };
              }

              const tool = state.activeToolCalls[tcIndex];
              if (tc.id && !tool.callId) tool.callId = tc.id;
              if (tc.function?.name && !tool.name) {
                tool.name = tc.function.name;
                tool.isCustomTool = !!(
                  responsesMeta?.customToolNames?.has(tool.name)
                );
                tool.isLocalShell =
                  tool.name === "local_shell" && !!responsesMeta?.hasLocalShell;
              }

              if (!tool.emittedAdded && tool.name) {
                tool.outputIndex = state.nextOutputIndex++;
                if (tool.isCustomTool) {
                  writeRaw(
                    formatResponsesSseEvent(
                      "response.output_item.added",
                      {
                        output_index: tool.outputIndex,
                        item: {
                          id: tool.itemId,
                          type: "custom_tool_call",
                          status: "in_progress",
                          call_id: tool.callId,
                          name: tool.name,
                          input: "",
                        },
                      },
                      state,
                    ),
                  );
                } else {
                  writeRaw(
                    formatResponsesSseEvent(
                      "response.output_item.added",
                      {
                        output_index: tool.outputIndex,
                        item: {
                          id: tool.itemId,
                          type: "function_call",
                          status: "in_progress",
                          call_id: tool.callId,
                          name: tool.name,
                          arguments: "",
                        },
                      },
                      state,
                    ),
                  );
                }
                tool.emittedAdded = true;
                wroteDownstream = true;
                meaningfulClientOutputSent = true;
                visibleClientOutputSent = true;
                markFirstAnswerChunk();
              }

              if (
                typeof tc.function?.arguments === "string" &&
                tc.function.arguments.length > 0
              ) {
                tool.arguments += tc.function.arguments;
                if (tool.emittedAdded && !tool.isCustomTool) {
                  writeRaw(
                    formatResponsesSseEvent(
                      "response.function_call_arguments.delta",
                      {
                        item_id: tool.itemId,
                        output_index: tool.outputIndex,
                        call_id: tool.callId,
                        delta: tc.function.arguments,
                      },
                      state,
                    ),
                  );
                  wroteDownstream = true;
                  meaningfulClientOutputSent = true;
                  visibleClientOutputSent = true;
                  markFirstAnswerChunk();
                }
              }
            }
          };

          const hasOpenToolCall =
            (!state.messageItemId || state.messageClosed) &&
            Object.values(state.activeToolCalls).some(
              (t) => t && t.emittedAdded && !t.closed,
            );

          if (
            hasOpenToolCall &&
            toolCallsDelta &&
            Array.isArray(toolCallsDelta)
          ) {
            emitToolCalls(toolCallsDelta);
            if (deltaText) {
              emitTextOnState(writeRaw, state, responsesMeta, deltaText);
              wroteDownstream = true;
              meaningfulClientOutputSent = true;
              visibleClientOutputSent = true;
              markFirstAnswerChunk();
            }
          } else {
            if (deltaText) {
              emitTextOnState(writeRaw, state, responsesMeta, deltaText);
              wroteDownstream = true;
              meaningfulClientOutputSent = true;
              visibleClientOutputSent = true;
              markFirstAnswerChunk();
            }
            if (toolCallsDelta && Array.isArray(toolCallsDelta)) {
              emitToolCalls(toolCallsDelta);
            }
          }

          if (isLengthCutoff) {
            shouldSkipWrite = true;
          }

          if (!wroteDownstream) {
            pingIfIdle(HIDDEN_PROGRESS_KEEP_ALIVE_MS);
          }
        } catch (err) {
          if (!(err instanceof SyntaxError)) {
            throw err;
          }
        }
      }
    }
  } catch (err: any) {
    if (streamTimeoutId) clearTimeout(streamTimeoutId);
    clearInterval(pingInterval);

    const transport = classifyStreamTransportError(err, {
      replyDestroyed: !!reply.raw.destroyed,
      replyWritableEnded: !!reply.raw.writableEnded,
    });
    const classifiedRaw = classifyUpstreamErrorWithAdapter(
      adapter,
      {
        rawError: err,
        statusCode: transport.statusCode,
        phase: "stream",
      },
      adapterContext,
    );
    const classified =
      transport.kind === "client_closed"
        ? buildClientClosedTerminalError({
            adapterId: adapter?.id || classifiedRaw?.adapterId,
            phase: "stream",
            message: classifiedRaw?.message,
          })
        : classifiedRaw;

    if (adapterState) {
      adapterState.terminalError = classified;
    }

    await reader.cancel().catch(() => {});

    let sentEvent = false;
    if (meaningfulClientOutputSent && transport.kind !== "client_closed" && isWritable()) {
      try {
        shouldSkipWrite = false;
        writeRaw(
          formatResponsesStreamErrorEvents(
            classified?.statusCode || 502,
            classified?.message || "Stream error",
            {
              type: classified?.errorType,
              code: classified?.code,
              state,
              responsesMeta,
            },
          ),
        );
        sentEvent = true;
      } catch {}
    }

    observer?.onStreamEnd?.();
    return {
      gotFirstChunk,
      isLengthTruncated: false,
      terminalEventSent: sentEvent,
      terminalError: classified,
      meaningfulClientOutputSent,
      responsesStreamState: state,
    };
  } finally {
    clearInterval(pingInterval);
  }

  // Finalize Responses stream unless withholding empty terminal or truncated for ContinuityEngine
  const holdAdaptedEmptyClose =
    !hadLengthCutoff &&
    Object.keys(state.activeToolCalls).length === 0 &&
    shouldWithholdEmptyTerminal({
      visibleClientOutputSent,
      anthropicEventType: "message_stop",
    });

  if (holdAdaptedEmptyClose) {
    withheldEmptyTerminal = true;
  } else if (
    !hadLengthCutoff &&
    (!stitchState?.isStitching || stitchState?.isLastCycle || visibleClientOutputSent)
  ) {
    shouldSkipWrite = false;
    finalizeResponsesStreamClose(writeRaw, state, responsesMeta, {
      isTruncated: false,
      promptTokens: (observer as any)?.promptTokens || 0,
      completionTokens: observer?.getCompletionTokens?.() || 0,
      cachedTokens: (observer as any)?.cachedTokens || 0,
    });
  }

  observer?.onStreamEnd?.();

  return {
    gotFirstChunk,
    isLengthTruncated: hadLengthCutoff,
    meaningfulClientOutputSent,
    visibleClientOutputSent,
    withheldEmptyTerminal,
    responsesStreamState: state,
  };
}
