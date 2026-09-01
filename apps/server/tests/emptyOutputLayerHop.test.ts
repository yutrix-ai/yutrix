import { describe, expect, it } from "vitest";
import {
  freezeUncutInboundBody,
  parseFunnelLayersFromRoute,
  selectEmptyOutputLayerHop,
  snapshotUncutInboundBody,
} from "../src/routes/gateway/emptyOutputLayerHop";

describe("selectEmptyOutputLayerHop", () => {
  const layers = [
    {
      index: 0,
      providerId: "p0",
      modelId: "gemini-3.7-flash-high",
      providerProtocol: "openai",
      visionRule: {
        providerId: "p0",
        modelId: "gemini-3.7-flash-high",
        providerProtocol: "openai",
        taskType: "vision",
      },
      windowLimit: 1_000_000,
    },
    {
      index: 1,
      providerId: "p1",
      modelId: "gemini-pro-agent",
      providerProtocol: "openai",
      visionRule: {
        providerId: "p1",
        modelId: "gemini-pro-vision",
        providerProtocol: "openai",
        taskType: "vision",
      },
      windowLimit: 1_000_000,
    },
    {
      index: 2,
      providerId: "p2",
      modelId: "qwen-long",
      providerProtocol: "openai",
      visionRule: {
        providerId: "p2",
        modelId: "qwen-long",
        providerProtocol: "openai",
        taskType: "long_context",
      },
      windowLimit: 1_000_000,
      strategyTaskType: "long_context",
    },
  ];

  it("picks the next funnel layer default model, not a same-layer strategy model", () => {
    const hop = selectEmptyOutputLayerHop({
      currentIndex: 0,
      hasImages: false,
      estimatedTokens: 6208,
      layers: [
        {
          ...layers[0],
          // same-layer strategy would have sent flash-tiered; hop must ignore that
          modelId: "gemini-3.7-flash-high",
        },
        layers[1],
      ],
    });
    expect(hop).toMatchObject({
      index: 1,
      providerId: "p1",
      modelId: "gemini-pro-agent",
      providerProtocol: "openai",
    });
    expect(hop?.modelId).not.toBe("gemini-3.7-flash-tiered");
    expect(hop?.index).toBe(1);
  });

  it("never selects a long_context strategy target", () => {
    const hop = selectEmptyOutputLayerHop({
      currentIndex: 0,
      hasImages: false,
      estimatedTokens: 6208,
      layers: [layers[0], { ...layers[1], strategyTaskType: "long_context", modelId: "qwen-long" }, layers[1]],
    });
    expect(hop?.modelId).toBe("gemini-pro-agent");
    expect(hop?.index).toBe(1);
  });

  it("skips image layers without a vision rule and does not use long_context as vision", () => {
    const hop = selectEmptyOutputLayerHop({
      currentIndex: 0,
      hasImages: true,
      estimatedTokens: 8000,
      layers: [
        layers[0],
        { ...layers[1], visionRule: null, modelId: "gemini-pro-agent" },
        layers[2],
        {
          index: 3,
          providerId: "p3",
          modelId: "claude-sonnet",
          providerProtocol: "anthropic",
          visionRule: {
            providerId: "p3",
            modelId: "claude-sonnet",
            providerProtocol: "anthropic",
            taskType: "vision",
          },
          windowLimit: 200_000,
        },
      ],
    });
    expect(hop).toMatchObject({
      index: 3,
      providerId: "p3",
      modelId: "claude-sonnet",
      providerProtocol: "anthropic",
    });
  });

  it("still hops to the next layer when that layer's window is too small", () => {
    const hop = selectEmptyOutputLayerHop({
      currentIndex: 0,
      hasImages: false,
      estimatedTokens: 80_000,
      layers: [
        layers[0],
        { ...layers[1], windowLimit: 10_000 },
        { ...layers[1], index: 2, providerId: "p2", modelId: "gemini-pro-agent", windowLimit: 200_000 },
      ],
    });
    expect(hop?.index).toBe(1);
    expect(hop?.modelId).toBe("gemini-pro-agent");
  });

  it("from a later layer still picks the next funnel layer, not the current one", () => {
    const hop = selectEmptyOutputLayerHop({
      currentIndex: 1,
      hasImages: false,
      estimatedTokens: 6208,
      layers: [
        layers[0],
        layers[1],
        { ...layers[1], index: 2, providerId: "p2", modelId: "claude-sonnet" },
        { ...layers[1], index: 3, providerId: "p3", modelId: "gemini-pro-agent" },
      ],
    });
    expect(hop).toMatchObject({
      index: 2,
      providerId: "p2",
      modelId: "claude-sonnet",
      providerProtocol: "openai",
    });
  });

  it("returns null when there is no later viable layer", () => {
    expect(
      selectEmptyOutputLayerHop({
        currentIndex: 0,
        hasImages: false,
        estimatedTokens: 100,
        layers: [layers[0]],
      }),
    ).toBeNull();
  });

  it("hops to the next layer even when 286k tokens exceed that layer's 256k window", () => {
    const hop = selectEmptyOutputLayerHop({
      currentIndex: 0,
      hasImages: false,
      estimatedTokens: 286751,
      layers: [
        layers[0],
        { ...layers[1], windowLimit: 262144 },
      ],
    });
    expect(hop).toMatchObject({
      index: 1,
      providerId: "p1",
      modelId: "gemini-pro-agent",
      capability: "text",
    });
  });

  it("keeps image empty-output on later vision at 286k and never selects long_context", () => {
    const hop = selectEmptyOutputLayerHop({
      currentIndex: 0,
      hasImages: true,
      estimatedTokens: 286751,
      layers: [
        layers[0],
        { ...layers[1], windowLimit: 262144 },
        layers[2],
      ],
    });
    expect(hop).toMatchObject({
      index: 1,
      providerId: "p1",
      modelId: "gemini-pro-vision",
      capability: "vision",
    });
    expect(hop?.modelId).not.toBe("qwen-long");
  });
});

describe("freezeUncutInboundBody", () => {
  it("stays uncut when a sibling clone is later clipped in place", () => {
    const inbound = {
      model: "gemini-3.7-flash-high",
      messages: [
        { role: "user", content: "old turn ".repeat(20) },
        { role: "assistant", content: "ok" },
        { role: "user", content: "latest" },
      ],
    };
    const frozen = freezeUncutInboundBody(inbound);
    const sibling = snapshotUncutInboundBody(frozen);
    sibling.messages = [sibling.messages[2]];
    expect(frozen.messages).toHaveLength(3);
    expect(frozen.messages[0].content).toContain("old turn");
    expect(sibling.messages).toHaveLength(1);
    expect(() => {
      (frozen as any).messages = [];
    }).toThrow();
  });
});

describe("snapshotUncutInboundBody", () => {
  it("keeps the original messages when the live body is later clipped", () => {
    const inbound = {
      model: "gemini-3.7-flash-high",
      messages: [
        { role: "user", content: "old turn ".repeat(20) },
        { role: "assistant", content: "ok" },
        { role: "user", content: "latest" },
      ],
    };
    const snap = snapshotUncutInboundBody(inbound);
    inbound.messages.splice(0, 2);
    expect(snap.messages).toHaveLength(3);
    expect(snap.messages[2].content).toBe("latest");
    expect(inbound.messages).toHaveLength(1);
  });
});

describe("parseFunnelLayersFromRoute", () => {
  it("reads targets[] as ordered layers", () => {
    const layers = parseFunnelLayersFromRoute({
      targets: JSON.stringify([
        { providerId: "p0", modelId: "flash-high", providerProtocol: "openai" },
        { providerId: "p1", modelId: "pro-agent", providerProtocol: "openai" },
      ]),
    });
    expect(layers.map((l) => l.modelId)).toEqual(["flash-high", "pro-agent"]);
  });
});
