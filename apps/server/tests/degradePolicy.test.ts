import { describe, expect, it } from "vitest";
import {
  classifyDegradeTrigger,
  isZeroVisibleOutput,
  LONG_CONTEXT_SIZE_GATE_TOKENS,
  meetsLongContextSizeGate,
  requiredCapability,
  selectAvailabilityNextLayer,
  shouldAttemptCapacityLongContext,
  shouldAttemptLongContextHop,
  shouldWithholdForZeroOutputDegrade,
  type FunnelLayerCandidate,
} from "../src/routes/gateway/degradePolicy";

const layers: FunnelLayerCandidate[] = [
  {
    index: 0,
    providerId: "p0",
    modelId: "gemini-flash",
    providerProtocol: "openai",
    vision: { providerId: "p0", modelId: "gemini-flash", providerProtocol: "openai" },
  },
  {
    index: 1,
    providerId: "p1",
    modelId: "poolside-256k",
    providerProtocol: "openai",
    vision: { providerId: "p1", modelId: "gemini-pro-vision", providerProtocol: "openai" },
  },
  {
    index: 2,
    providerId: "p2",
    modelId: "qwen-long",
    providerProtocol: "openai",
    vision: null,
  },
  {
    index: 3,
    providerId: "p3",
    modelId: "claude-sonnet",
    providerProtocol: "anthropic",
    vision: { providerId: "p3", modelId: "claude-sonnet", providerProtocol: "anthropic" },
  },
];

describe("degrade class", () => {
  it("treats zero output, 429, 5xx, and concurrency as availability", () => {
    expect(classifyDegradeTrigger("zero_output")).toBe("availability");
    expect(classifyDegradeTrigger("rate_limited")).toBe("availability");
    expect(classifyDegradeTrigger("upstream_unavailable")).toBe("availability");
    expect(classifyDegradeTrigger("concurrency")).toBe("availability");
  });

  it("treats model-window overflow as capacity and group/user clip as quota", () => {
    expect(classifyDegradeTrigger("context_overflow")).toBe("capacity");
    expect(classifyDegradeTrigger("group_clip_overflow")).toBe("quota");
  });
});

describe("256Ki long_context size gate", () => {
  it("is strict greater-than 256Ki", () => {
    expect(LONG_CONTEXT_SIZE_GATE_TOKENS).toBe(256 * 1024);
    expect(meetsLongContextSizeGate(262144)).toBe(false);
    expect(meetsLongContextSizeGate(262145)).toBe(true);
  });

  it("hops non-vision above 256Ki even when the current window still fits", () => {
    expect(shouldAttemptLongContextHop({
      hasImages: false,
      isContextExhausted: false,
      estimatedTotalTokens: 262145,
    })).toBe(true);
  });

  it("does not hop at exactly 256Ki when the current window still fits", () => {
    expect(shouldAttemptLongContextHop({
      hasImages: false,
      isContextExhausted: false,
      estimatedTotalTokens: 262144,
    })).toBe(false);
  });
});

describe("capacity long_context hop", () => {
  it("hops when the current model cannot hold the request", () => {
    expect(shouldAttemptCapacityLongContext({
      isContextExhausted: true,
      overflowFromGroupClip: false,
      estimatedTotalTokens: 100_000,
    })).toBe(true);
  });

  it("does not treat group/user clip as a hop reason", () => {
    expect(shouldAttemptCapacityLongContext({
      isContextExhausted: false,
      overflowFromGroupClip: true,
      estimatedTotalTokens: 100_000,
    })).toBe(false);
  });

  it("never hops vision, including 256K+, window overflow, or quota clip", () => {
    expect(shouldAttemptLongContextHop({
      hasImages: true,
      isContextExhausted: true,
      estimatedTotalTokens: 500_000,
    })).toBe(false);
    expect(shouldAttemptLongContextHop({
      hasImages: true,
      isContextExhausted: false,
      overflowFromGroupClip: true,
      estimatedTotalTokens: 500_000,
    })).toBe(false);
  });
});

describe("zero visible output", () => {
  it("is empty when there is no visible text and no tool call", () => {
    expect(isZeroVisibleOutput({ hasVisibleText: false, hasToolCall: false })).toBe(true);
  });

  it("is not empty when the model produced visible text or a tool call", () => {
    expect(isZeroVisibleOutput({ hasVisibleText: true, hasToolCall: false })).toBe(false);
    expect(isZeroVisibleOutput({ hasVisibleText: false, hasToolCall: true })).toBe(false);
  });
});

describe("availability next-layer hop", () => {
  it("always walks to the next text layer, ignoring window size", () => {
    const hop = selectAvailabilityNextLayer({
      currentIndex: 0,
      hasImages: false,
      layers,
    });
    expect(hop).toEqual({
      index: 1,
      providerId: "p1",
      modelId: "poolside-256k",
      providerProtocol: "openai",
      capability: "text",
    });
  });

  it("keeps images on the next layer's vision target, skipping layers without vision", () => {
    const hop = selectAvailabilityNextLayer({
      currentIndex: 1,
      hasImages: true,
      layers,
    });
    expect(hop).toEqual({
      index: 3,
      providerId: "p3",
      modelId: "claude-sonnet",
      providerProtocol: "anthropic",
      capability: "vision",
    });
  });

  it("returns null only when no later capable layer exists", () => {
    expect(selectAvailabilityNextLayer({
      currentIndex: 3,
      hasImages: false,
      layers,
    })).toBeNull();
    expect(selectAvailabilityNextLayer({
      currentIndex: 3,
      hasImages: true,
      layers,
    })).toBeNull();
  });
});

describe("withhold terminal for zero-output degrade", () => {
  it("holds stop when nothing visible was sent, even if reasoning exists upstream", () => {
    expect(shouldWithholdForZeroOutputDegrade({
      visibleClientOutputSent: false,
    })).toBe(true);
  });

  it("does not hold after visible text or tool content", () => {
    expect(shouldWithholdForZeroOutputDegrade({
      visibleClientOutputSent: true,
    })).toBe(false);
    expect(shouldWithholdForZeroOutputDegrade({
      visibleClientOutputSent: false,
      eventHasSemanticContent: true,
    })).toBe(false);
  });
});

describe("required capability", () => {
  it("maps images to vision and everything else to text", () => {
    expect(requiredCapability(true)).toBe("vision");
    expect(requiredCapability(false)).toBe("text");
  });
});
