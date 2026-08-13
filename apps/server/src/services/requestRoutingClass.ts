import {
  looksLikeClientSidecarRequestRaw,
  looksLikeClientSidecarText,
  looksLikeContinuationRequestRaw,
} from "../utils/chatTurnsDetector";

export const GATEWAY_REQUEST_CLASSES = [
  "user_intent",
  "tool_continuation",
  "client_sidecar",
] as const;

export type GatewayRequestClass = (typeof GATEWAY_REQUEST_CLASSES)[number];

export interface RequestClassDecision {
  requestClass: GatewayRequestClass;
  reasons: string[];
}

/**
 * Protocol-agnostic turn role. New client envelopes belong here — not in
 * Anthropic/OpenAI adapters and not inside task-type classifiers.
 *
 * Sidecar beats continuation: a Stage-1 classifier that happens to look like
 * a tool follow-up must not inherit the sticky debug model.
 */
export function classifyGatewayRequestClass(body: any): RequestClassDecision {
  if (looksLikeClientSidecarRequestRaw(body)) {
    return { requestClass: "client_sidecar", reasons: ["client_sidecar"] };
  }
  if (looksLikeContinuationRequestRaw(body)) {
    return { requestClass: "tool_continuation", reasons: ["continuation_request"] };
  }
  return { requestClass: "user_intent", reasons: ["user_intent"] };
}

export function extractClientRequestedModel(body: any): string | null {
  if (!body || typeof body !== "object") return null;
  for (const key of ["model", "model_id", "modelId"] as const) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Lightweight / background families the client already chose.
 * Route defaults like `*-flash-tiered` stay eligible for debug/code upgrade.
 * Explicit haiku / mini / nano / flash-lite must not be promoted.
 */
export function isClientNamedSmallFastModel(
  modelId: string | null | undefined,
): boolean {
  if (!modelId) return false;
  const n = modelId.trim().toLowerCase();
  if (!n) return false;
  if (/(^|[^a-z0-9])(haiku|mini|nano|tiny)([^a-z0-9]|$)/.test(n)) return true;
  if (/small[-_]?fast|background/.test(n)) return true;
  if (/flash[-_]?lite/.test(n)) return true;
  return false;
}

export function shouldRecordStrategyRoutingHop(
  from: { providerId?: string | null; modelId?: string | null },
  to: { providerId?: string | null; modelId?: string | null },
): boolean {
  const fromProvider = from.providerId || "";
  const toProvider = to.providerId || "";
  const fromModel = from.modelId || "";
  const toModel = to.modelId || "";
  if (!toProvider && !toModel) return false;
  return fromProvider !== toProvider || fromModel !== toModel;
}

export function selectStickyModelFromLogRows(
  rows: Array<{ model?: string | null; inputText?: string | null }>,
): string | null {
  for (const row of rows) {
    if (looksLikeClientSidecarText(row.inputText)) continue;
    if (row.model) return row.model;
  }
  return null;
}

export function selectStickyTurnFromLogRows(
  rows: Array<{ model?: string | null; inputText?: string | null }>,
): { model: string; inputText: string } | null {
  for (const row of rows) {
    if (looksLikeClientSidecarText(row.inputText)) continue;
    return { model: row.model || "", inputText: row.inputText || "" };
  }
  return null;
}
