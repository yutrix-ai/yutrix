/**
 * Availability vs capacity vs quota.
 *
 * Quota (user/group max-input): always clip. Never a long_context hop.
 * Availability (zero output, 429, 5xx, concurrency): next capable funnel
 * layer. Images stay on vision. Window size is ignored.
 * Capacity (current model window exceeded) and the 256Ki size gate:
 * non-vision only → long_context. Vision never uses long_context.
 */

export const LONG_CONTEXT_SIZE_GATE_TOKENS = 256 * 1024;

export type RequiredCapability = "vision" | "text";

export type DegradeClass = "availability" | "capacity" | "quota";

export type DegradeTrigger =
  | "zero_output"
  | "rate_limited"
  | "upstream_unavailable"
  | "concurrency"
  | "context_overflow"
  | "group_clip_overflow";

export type FunnelLayerCandidate = {
  index: number;
  providerId: string;
  modelId: string;
  providerProtocol: string;
  vision?: {
    providerId: string;
    modelId: string;
    providerProtocol: string;
  } | null;
};

export type AvailabilityHop = {
  index: number;
  providerId: string;
  modelId: string;
  providerProtocol: string;
  capability: RequiredCapability;
};

export function requiredCapability(hasImages: boolean): RequiredCapability {
  return hasImages ? "vision" : "text";
}

export function classifyDegradeTrigger(trigger: DegradeTrigger): DegradeClass {
  if (trigger === "group_clip_overflow") return "quota";
  if (trigger === "context_overflow") return "capacity";
  return "availability";
}

/** Strict greater-than 256Ki. Cheap numeric gate — caller supplies a rough estimate. */
export function meetsLongContextSizeGate(estimatedInputTokens: number): boolean {
  return (
    Number.isFinite(estimatedInputTokens)
    && estimatedInputTokens > LONG_CONTEXT_SIZE_GATE_TOKENS
  );
}

/**
 * Non-vision long_context override. Vision never takes this path.
 * Group/user quota clipping (`overflowFromGroupClip`) is ignored — quota always clips.
 */
export function shouldAttemptLongContextHop(options: {
  hasImages?: boolean;
  isContextExhausted: boolean;
  estimatedTotalTokens?: number;
  overflowFromGroupClip?: boolean;
}): boolean {
  if (options.hasImages) return false;
  if (options.isContextExhausted) return true;
  return meetsLongContextSizeGate(options.estimatedTotalTokens ?? 0);
}

/** @deprecated Prefer shouldAttemptLongContextHop. */
export function shouldAttemptCapacityLongContext(options: {
  isContextExhausted: boolean;
  overflowFromGroupClip?: boolean;
  hasImages?: boolean;
  estimatedTotalTokens?: number;
}): boolean {
  return shouldAttemptLongContextHop(options);
}

/**
 * Visible emptiness for EmptyOutput. Reasoning / <think> is not a client
 * answer. Tool calls are a successful action even with empty text.
 */
export function isZeroVisibleOutput(options: {
  hasVisibleText: boolean;
  hasToolCall: boolean;
}): boolean {
  return !options.hasVisibleText && !options.hasToolCall;
}

/**
 * Next funnel layer for an availability failure.
 * Images stay on a vision target; layers without a vision rule are skipped.
 * Window size is intentionally ignored.
 */
export function selectAvailabilityNextLayer(input: {
  currentIndex: number;
  hasImages: boolean;
  layers: FunnelLayerCandidate[];
}): AvailabilityHop | null {
  const currentIndex = Number(input.currentIndex) || 0;
  const later = [...input.layers]
    .filter((layer) => Number(layer.index) > currentIndex)
    .sort((a, b) => a.index - b.index);

  for (const layer of later) {
    if (input.hasImages) {
      const vision = layer.vision;
      if (!vision?.providerId || !vision?.modelId) continue;
      return {
        index: layer.index,
        providerId: vision.providerId,
        modelId: vision.modelId,
        providerProtocol: vision.providerProtocol || layer.providerProtocol || "openai",
        capability: "vision",
      };
    }
    if (!layer.providerId || !layer.modelId) continue;
    return {
      index: layer.index,
      providerId: layer.providerId,
      modelId: layer.modelId,
      providerProtocol: layer.providerProtocol || "openai",
      capability: "text",
    };
  }
  return null;
}

/** Hold stream stop/[DONE] so a zero-output availability hop can still run. */
export function shouldWithholdForZeroOutputDegrade(input: {
  visibleClientOutputSent: boolean;
  eventHasSemanticContent?: boolean;
}): boolean {
  if (input.visibleClientOutputSent) return false;
  if (input.eventHasSemanticContent) return false;
  return true;
}
