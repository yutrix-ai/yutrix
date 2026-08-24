import { describe, expect, it } from "vitest";
import {
  classifyDegradeTrigger,
  isZeroVisibleOutput,
  requiredCapability,
  selectAvailabilityNextLayer,
  shouldAttemptCapacityLongContext,
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

  it("treats window overflow and group-clip overflow as capacity", () => {
    expect(classifyDegradeTrigger("context_overflow")).toBe("capacity");
    expect(classifyDegradeTrigger("group_clip_overflow")).toBe("capacity");
  });
});

describe("capacity long_context hop", () => {
  it("hops only when the current model cannot hold the request", () => {
    expect(shouldAttemptCapacityLongContext({
      isContextExhausted: true,
      overflowFromGroupClip: false,
    })).toBe(true);
    expect(shouldAttemptCapacityLongContext({
      isContextExhausted: false,
      overflowFromGroupClip: true,
    })).toBe(true);
  });

  it("does not hop a large request that still fits the current model", () => {
    expect(shouldAttemptCapacityLongContext({
      isContextExhausted: false,
      overflowFromGroupClip: false,
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
