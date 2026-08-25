import { describe, expect, it } from "vitest";
import {
  decideGroupClipOverflow,
  shouldOverflowHopInsteadOfClip,
  overflowHopTaskOrder,
  resolveGroupClipOverflowHop,
} from "../src/routes/gateway/overflowContextHop";
import {
  applyInputTokenLimit,
  previewInputTokenLimit,
} from "../src/routes/gateway/inputTokenLimit";
import { applyForcedInputTokenLimit, enforceInputTokenLimit } from "../src/routes/gateway/inputTokenLimitGuard";
import { LONG_CONTEXT_STRATEGY_MIN_INPUT_TOKENS } from "../src/services/strategyRouting";

function overflowBody() {
  return {
    model: "gemini-3.7-flash-tiered",
    messages: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "old turn one ".repeat(400) },
      { role: "assistant", content: "old answer one" },
      { role: "user", content: "old turn two ".repeat(400) },
      { role: "assistant", content: "old answer two" },
      { role: "user", content: "latest question with enough leftover room" },
    ],
  };
}

describe("decideGroupClipOverflow", () => {
  it("never hops to long_context when group/user clipping would drop turns", () => {
    const decision = decideGroupClipOverflow({
      droppedTurns: 9,
      originalTokens: 276348,
      hasImages: false,
    });
    expect(decision.hop).toBe(false);
    expect(decision.applyOneMillionFloor).toBe(false);
    expect(decision.preferVision).toBe(false);
    expect(276348).toBeLessThan(LONG_CONTEXT_STRATEGY_MIN_INPUT_TOKENS);
  });

  it("still does not hop when the over-budget request has images", () => {
    const decision = decideGroupClipOverflow({
      droppedTurns: 2,
      originalTokens: 180000,
      hasImages: true,
    });
    expect(decision.hop).toBe(false);
    expect(decision.preferVision).toBe(true);
    expect(decision.applyOneMillionFloor).toBe(false);
  });

  it("does not hop when no turns would be dropped", () => {
    expect(decideGroupClipOverflow({ droppedTurns: 0, originalTokens: 13033 }).hop).toBe(false);
    expect(shouldOverflowHopInsteadOfClip({ droppedTurns: 0, truncated: false })).toBe(false);
  });

  it("never treats droppedTurns as a reason to hop instead of clip", () => {
    expect(shouldOverflowHopInsteadOfClip({ droppedTurns: 9, truncated: true })).toBe(false);
  });

  it("keeps images on vision only; text overflow may use long_context", () => {
    expect(overflowHopTaskOrder(true)).toEqual(["vision"]);
    expect(overflowHopTaskOrder(false)).toEqual(["long_context"]);
  });
});

describe("resolveGroupClipOverflowHop (shipped hop resolution)", () => {
  it("hops to configured LC then clips to the LC window when that window is smaller than unclipped", () => {
    const resolved = resolveGroupClipOverflowHop({
      hasImages: false,
      estimatedTokens: 276348,
      currentProviderId: "prov-flash",
      currentModelId: "gemini-3.7-flash-tiered",
      visionCandidates: [],
      longContextCandidate: {
        providerId: "prov-lc",
        providerProtocol: "openai",
        modelId: "qwen-long",
        windowLimit: 200000,
      },
    });
    expect(resolved.action).toBe("hop");
    if (resolved.action === "hop") {
      expect(resolved.taskType).toBe("long_context");
      expect(resolved.modelId).toBe("qwen-long");
      expect(resolved.providerId).toBe("prov-lc");
      expect(resolved.clipToWindow).toBe(200000);
    }
  });

  it("does not last-resort clip on the original model when LC window cannot hold unclipped tokens", () => {
    const resolved = resolveGroupClipOverflowHop({
      hasImages: false,
      estimatedTokens: 276348,
      currentProviderId: "prov-flash",
      currentModelId: "gemini-3.7-flash-tiered",
      visionCandidates: [],
      longContextCandidate: {
        providerId: "prov-lc",
        providerProtocol: "anthropic",
        modelId: "claude-long",
        windowLimit: 120000,
      },
    });
    expect(resolved.action).not.toBe("last_resort_group_clip");
    expect(resolved.action).toBe("hop");
    if (resolved.action === "hop") {
      expect(resolved.clipToWindow).toBe(120000);
      expect(resolved.modelId).not.toBe("gemini-3.7-flash-tiered");
    }
  });

  it("never falls through to long_context when the request has images", () => {
    const resolved = resolveGroupClipOverflowHop({
      hasImages: true,
      estimatedTokens: 276348,
      currentProviderId: "prov-flash",
      currentModelId: "gemini-3.7-flash-tiered",
      visionCandidates: [
        {
          providerId: "prov-vision",
          providerProtocol: "openai",
          modelId: "gemini-vision-small",
          targetIndex: 1,
          windowLimit: 80000,
        },
      ],
      longContextCandidate: {
        providerId: "prov-lc",
        providerProtocol: "openai",
        modelId: "qwen-long",
        windowLimit: 160000,
      },
    });
    expect(resolved.action).toBe("last_resort_group_clip");
  });

  it("hops images to a later vision window that can hold the estimate", () => {
    const resolved = resolveGroupClipOverflowHop({
      hasImages: true,
      estimatedTokens: 80_000,
      currentProviderId: "prov-flash",
      currentModelId: "gemini-3.7-flash-tiered",
      visionCandidates: [
        {
          providerId: "prov-vision",
          providerProtocol: "openai",
          modelId: "gemini-vision-large",
          targetIndex: 1,
          windowLimit: 200_000,
        },
      ],
      longContextCandidate: {
        providerId: "prov-lc",
        providerProtocol: "openai",
        modelId: "qwen-long",
        windowLimit: 1_000_000,
      },
    });
    expect(resolved.action).toBe("hop");
    if (resolved.action === "hop") {
      expect(resolved.taskType).toBe("vision");
      expect(resolved.modelId).toBe("gemini-vision-large");
    }
  });

  it("stays when the configured LC target is already the current model", () => {
    const resolved = resolveGroupClipOverflowHop({
      hasImages: false,
      estimatedTokens: 276348,
      currentProviderId: "prov-lc",
      currentModelId: "qwen-long",
      visionCandidates: [],
      longContextCandidate: {
        providerId: "prov-lc",
        providerProtocol: "openai",
        modelId: "qwen-long",
        windowLimit: 200000,
      },
    });
    expect(resolved.action).toBe("stay");
    if (resolved.action === "stay") {
      expect(resolved.clipToWindow).toBe(200000);
    }
  });
});

describe("previewInputTokenLimit does not mutate the outbound body", () => {
  it("reports droppedTurns > 0 while leaving messages intact", async () => {
    const body = overflowBody();
    const snapshot = JSON.stringify(body.messages);
    const preview = await previewInputTokenLimit(body, {
      maxInputTokens: 200,
      modelId: "gemini-3.7-flash-tiered",
      providerProtocol: "openai",
    });
    expect(preview.truncated).toBe(true);
    expect(preview.droppedTurns).toBeGreaterThan(0);
    expect(shouldOverflowHopInsteadOfClip(preview)).toBe(false);
    expect(JSON.stringify(body.messages)).toBe(snapshot);
  });

  it("applyInputTokenLimit still clips when explicitly asked (last-resort path)", async () => {
    const body = overflowBody();
    const result = await applyInputTokenLimit(body, {
      maxInputTokens: 200,
      modelId: "gemini-3.7-flash-tiered",
      providerProtocol: "openai",
    });
    expect(result.droppedTurns).toBeGreaterThan(0);
    expect(body.messages.some((m: any) => String(m.content).includes("old turn one"))).toBe(false);
    expect(body.messages.some((m: any) => String(m.content).includes("latest question"))).toBe(true);
  });
});

describe("enforceInputTokenLimit always clips quota overage", () => {
  function mockCtx(overrides: Record<string, any> = {}) {
    return {
      inputTokenLimit: { maxInputTokens: 200, source: "group", sourceLabel: "默认组" },
      routing: { incomingProtocol: "openai" },
      stream: { estimatedPromptTokens: 0 },
      overflowHopApplied: false,
      ...overrides,
    } as any;
  }

  it("clips dropped turns and logs token.max_input.truncated instead of hopping to long_context", async () => {
    const body = overflowBody();
    const logged: any[] = [];
    const result = await enforceInputTokenLimit({
      ctx: mockCtx(),
      modifiedBody: body,
      provider: { name: "Antigravity_US2" },
      currentAttempt: { modelId: "gemini-3.7-flash-tiered", providerProtocol: "openai" },
      activeModelConfig: null,
      baseActionLog: { requestId: "req-overflow" },
      logAction: (e: any) => logged.push(e),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result as { overflowHop?: unknown }).overflowHop).toBeUndefined();
      expect(result.truncatedBody).toBeDefined();
    }
    expect(body.messages.some((m: any) => String(m.content).includes("old turn one"))).toBe(false);
    expect(body.messages.some((m: any) => String(m.content).includes("latest question"))).toBe(true);
    expect(logged.some((e) => e.code === "token.max_input.truncated")).toBe(true);
    expect(logged.some((e) => e.code === "token.max_input.truncated" && e.droppedTurns > 0)).toBe(true);
  });

  it("clips normally when the body fits without dropping turns", async () => {
    const body = {
      model: "gemini-3.7-flash-tiered",
      messages: [{ role: "user", content: "hello" }],
    };
    const logged: any[] = [];
    const result = await enforceInputTokenLimit({
      ctx: mockCtx({ inputTokenLimit: { maxInputTokens: 10000, source: "group", sourceLabel: "默认组" } }),
      modifiedBody: body,
      provider: { name: "Antigravity_US2" },
      currentAttempt: { modelId: "gemini-3.7-flash-tiered", providerProtocol: "openai" },
      activeModelConfig: null,
      baseActionLog: { requestId: "req-fit" },
      logAction: (e: any) => logged.push(e),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.overflowHop).toBeUndefined();
    }
    expect(body.messages).toHaveLength(1);
    expect(logged.some((e) => e.code === "token.max_input.truncated")).toBe(false);
  });

  it("skips group clip after an overflow hop has already been applied", async () => {
    const body = overflowBody();
    const snapshot = JSON.stringify(body.messages);
    const logged: any[] = [];
    const result = await enforceInputTokenLimit({
      ctx: mockCtx({ overflowHopApplied: true }),
      modifiedBody: body,
      provider: { name: "Antigravity_US2" },
      currentAttempt: { modelId: "long-context-model", providerProtocol: "openai" },
      activeModelConfig: null,
      baseActionLog: { requestId: "req-hopped" },
      logAction: (e: any) => logged.push(e),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.overflowHop).toBeUndefined();
      expect(result.truncatedBody).toBeUndefined();
    }
    expect(JSON.stringify(body.messages)).toBe(snapshot);
    expect(logged).toHaveLength(0);
  });
});

describe("applyForcedInputTokenLimit last-resort clip", () => {
  it("does not throw when images cannot shrink into the window", async () => {
    const body = {
      model: "vision-model",
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,aaa" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,bbb" } },
          { type: "text", text: "hi" },
        ],
      }],
    };
    const snapshot = JSON.stringify(body.messages);
    const logged: any[] = [];
    const clipped = await applyForcedInputTokenLimit({
      ctx: { stream: { estimatedPromptTokens: 0 }, inputTokenLimit: { source: "model_window", sourceLabel: "vision-model" } } as any,
      modifiedBody: body,
      provider: { name: "vision-prov" },
      currentAttempt: { modelId: "vision-model", providerProtocol: "openai" } as any,
      activeModelConfig: null,
      baseActionLog: { requestId: "req-vision-clip" } as any,
      logAction: (e: any) => logged.push(e),
      maxInputTokens: 100,
      limitSource: "model_window",
      limitSourceLabel: "vision-model",
    });
    expect(clipped.messages).toEqual(JSON.parse(snapshot));
    expect(logged.some((e) => e.code === "token.max_input.rejected")).toBe(true);
  });
});
