import {
  getMessagesFromParsedRequest,
  selectCurrentInputMessages,
  serializeContentForLog,
  serializeMessagesForLog,
} from "../utils/chatTurns";
import type { GatewayRequestClass } from "./requestRoutingClass";

/**
 * Routing modes for a route's funnel layers.
 * - "strategy": developer/IDE traffic (vision/debug/code/long_context/writing/general).
 * - "opc_agent": autonomous OS-agent traffic over an OpenAI-compatible endpoint
 *   (rakazo, Open Interpreter, browser-use, …), routed by agent-loop phase:
 *   vision/thinking/action/auto_review/memory/general.
 */
export const ROUTING_MODES = ["strategy", "opc_agent"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export function isRoutingMode(value: unknown): value is RoutingMode {
  return typeof value === "string" && (ROUTING_MODES as readonly string[]).includes(value);
}

export function resolveRouteRoutingMode(route: any): RoutingMode {
  const raw = route?.routingMode;
  return isRoutingMode(raw) ? raw : "strategy";
}

export const OPC_AGENT_TASK_TYPES = [
  "vision",
  "thinking",
  "action",
  "auto_review",
  "memory",
  "general",
] as const;

export type OpcAgentTaskType = (typeof OPC_AGENT_TASK_TYPES)[number];

const OPC_TASK_TYPE_SET = new Set<string>(OPC_AGENT_TASK_TYPES);

export function isOpcAgentTaskType(value: unknown): value is OpcAgentTaskType {
  return typeof value === "string" && OPC_TASK_TYPE_SET.has(value);
}

/**
 * Capacity column per mode: when the input overflows the current model's
 * window, strategy mode hops to the dedicated long_context column, while
 * OPC agent mode hops to the memory column (its compaction/long-context
 * model is by definition a large-window, cheap-throughput model).
 */
export function capacityTaskTypeForMode(mode: RoutingMode): "long_context" | "memory" {
  return mode === "opc_agent" ? "memory" : "long_context";
}

/**
 * Layer-aware strategy enablement. Funnel routes store the flag on each
 * target layer; the legacy top-level column is only a fallback for
 * pre-funnel rows (the CRUD path no longer writes it).
 */
export function strategyRoutingEnabledForLayer(route: any, targetIndex: number): boolean {
  if (route?.targets) {
    try {
      const parsed =
        typeof route.targets === "string" ? JSON.parse(route.targets) : route.targets;
      if (Array.isArray(parsed) && parsed.length > targetIndex) {
        return !!parsed[targetIndex]?.strategyRoutingEnabled;
      }
    } catch {
      // fall through to the top-level flag
    }
  }
  return !!route?.strategyRoutingEnabled;
}

export interface OpcAgentClassification {
  taskType: OpcAgentTaskType;
  reasons: string[];
}

/**
 * rakazo auto-review judge fingerprints (hardcoded templates in
 * rakazo/packages/adapters/src/auto-review.ts). The judge runs with an
 * aggressive default timeout (1.5s), so it must land on the fastest column.
 */
const AUTO_REVIEW_SYSTEM_RE = /you are a fast safety checker/i;
const AUTO_REVIEW_PROMPT_RE =
  /decide if this bot action is unexpected or dangerous relative to the user task/i;
/** Generic judge shape: strict-JSON verdict over tagged untrusted payloads. */
const AUTO_REVIEW_TAGGED_PAYLOAD_RE = /<tool_args>[\s\S]{0,4000}<\/tool_args>/i;
const AUTO_REVIEW_TASK_TAG_RE = /<user_task>/i;

/**
 * rakazo history-compaction fingerprints (hardcoded templates in
 * rakazo/packages/adapters/src/history-compaction.ts). Compaction shares the
 * main conversation's model resolver, so it always transits this gateway.
 */
const COMPACTION_SYSTEM_RE =
  /produce a complete replacement summary of the conversation context/i;
const COMPACTION_PROMPT_RE = /<previous_compacted_summary>/i;
/** Generic toolless summarize/compact-the-conversation background jobs. */
const COMPACTION_GENERIC_RE =
  /\b(?:compact|summari[sz]e|condense|distill)\b[\s\S]{0,80}\b(?:conversation|chat|dialog(?:ue)?|history|context|transcript|memory)\b/i;

const CLASSIFY_TEXT_WINDOW = 8_000;

function extractSystemTextForOpc(body: any): string {
  if (!body || typeof body !== "object") return "";
  const parts: string[] = [];
  if (typeof body.system === "string") {
    parts.push(body.system);
  } else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (typeof block === "string") parts.push(block);
      else if (block && typeof block.text === "string") parts.push(block.text);
    }
  }
  const messages = getMessagesFromParsedRequest(body);
  for (const msg of messages) {
    if (msg?.role !== "system" && msg?.role !== "developer") continue;
    const content = msg.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "string") parts.push(block);
        else if (block && block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
    }
    if (parts.join("\n").length >= CLASSIFY_TEXT_WINDOW) break;
  }
  return parts.join("\n").slice(0, CLASSIFY_TEXT_WINDOW);
}

function extractCurrentInputTextForOpc(body: any): string {
  const messages = getMessagesFromParsedRequest(body);
  if (messages.length > 0) {
    const currentInput = selectCurrentInputMessages(messages);
    const serialized = serializeMessagesForLog(currentInput.messages);
    if (serialized?.trim()) return serialized.slice(0, CLASSIFY_TEXT_WINDOW);
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    if (body.prompt !== undefined) {
      return (serializeContentForLog(body.prompt) || "").slice(0, CLASSIFY_TEXT_WINDOW);
    }
    if (body.input !== undefined) {
      return (serializeContentForLog(body.input) || "").slice(0, CLASSIFY_TEXT_WINDOW);
    }
  }
  return "";
}

function hasToolDefinitions(body: any): boolean {
  return !!body && Array.isArray(body.tools) && body.tools.length > 0;
}

/** Explicit client-side reasoning knobs (forward-compatible; rakazo's OPC provider sends none today). */
function requestsExplicitReasoning(body: any): boolean {
  if (!body || typeof body !== "object") return false;
  if (typeof body.reasoning_effort === "string" && body.reasoning_effort !== "none") {
    return true;
  }
  if (body.thinking && typeof body.thinking === "object" && body.thinking.type === "enabled") {
    return true;
  }
  if (
    body.reasoning &&
    typeof body.reasoning === "object" &&
    typeof body.reasoning.effort === "string" &&
    body.reasoning.effort !== "none"
  ) {
    return true;
  }
  return false;
}

/**
 * Phase-based classifier for OPC agent traffic. Structural signals only —
 * O(1) over a bounded text window, no jieba/semantic scoring:
 *
 * 1. vision       — outbound payload carries image parts (screenshots, uploads).
 * 2. auto_review  — safety-judge fingerprint on a fresh, toolless prompt.
 * 3. memory       — history-compaction fingerprint on a fresh, toolless prompt.
 * 4. action       — tool continuation: the agent is inside its execution loop.
 * 5. thinking     — a real user goal arriving at a tool-equipped agent (planning
 *                   turn), or explicit reasoning knobs on the request.
 * 6. general      — everything else (toolless chatter, titles, background jobs).
 */
export function classifyOpcAgentTask(options: {
  body: any;
  requestClass: GatewayRequestClass;
  hasImageInput: boolean;
}): OpcAgentClassification {
  const { body, requestClass, hasImageInput } = options;

  if (hasImageInput) {
    return { taskType: "vision", reasons: ["opc_image_payload"] };
  }

  const isToolContinuation = requestClass === "tool_continuation";
  const toolless = !hasToolDefinitions(body);

  if (!isToolContinuation && toolless) {
    const systemText = extractSystemTextForOpc(body);
    const inputText = extractCurrentInputTextForOpc(body);

    if (AUTO_REVIEW_SYSTEM_RE.test(systemText) || AUTO_REVIEW_PROMPT_RE.test(inputText)) {
      return { taskType: "auto_review", reasons: ["opc_auto_review_fingerprint"] };
    }
    if (
      AUTO_REVIEW_TAGGED_PAYLOAD_RE.test(inputText) &&
      AUTO_REVIEW_TASK_TAG_RE.test(inputText)
    ) {
      return { taskType: "auto_review", reasons: ["opc_judge_payload_shape"] };
    }

    if (COMPACTION_SYSTEM_RE.test(systemText) || COMPACTION_PROMPT_RE.test(inputText)) {
      return { taskType: "memory", reasons: ["opc_compaction_fingerprint"] };
    }
    if (COMPACTION_GENERIC_RE.test(systemText) || COMPACTION_GENERIC_RE.test(inputText)) {
      return { taskType: "memory", reasons: ["opc_compaction_generic"] };
    }
  }

  if (isToolContinuation) {
    return { taskType: "action", reasons: ["opc_tool_loop"] };
  }

  if (requestsExplicitReasoning(body)) {
    return { taskType: "thinking", reasons: ["opc_explicit_reasoning_param"] };
  }
  if (!toolless) {
    return { taskType: "thinking", reasons: ["opc_planning_turn"] };
  }

  return { taskType: "general", reasons: ["opc_default"] };
}
