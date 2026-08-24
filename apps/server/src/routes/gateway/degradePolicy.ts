/**
 * Availability vs capacity degrade policy.
 *
 * Availability (zero output, 429, 5xx, concurrency): keep required
 * capability and walk to the next funnel layer. Do not skip a layer
 * because its default window is too small — capacity is handled after
 * landing, via that layer's own strategy + long_context overflow.
 *
 * Capacity (model window exceeded, group-clip would drop turns): hop to
 * the current layer's long_context slot only. 429 / empty must not use
 * this path.
 *
 * Zero visible output is always availability, including reasoning-only
 * payloads with no tool call and no user-visible text.
 */

export type RequiredCapability = "vision" | "text";

export type DegradeClass = "availability" | "capacity";

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
  if (trigger === "context_overflow" || trigger === "group_clip_overflow") {
    return "capacity";
  }
  return "availability";
}

/**
 * Capacity hop only. Never use a token-count floor when the current
 * model still fits — large-but-fitting requests stay on the strategy target.
 */
export function shouldAttemptCapacityLongContext(options: {
  isContextExhausted: boolean;
  overflowFromGroupClip: boolean;
}): boolean {
  return options.isContextExhausted === true || options.overflowFromGroupClip === true;
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
