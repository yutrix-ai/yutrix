import { describe, expect, it } from "vitest";
import {
  decideGroupClipOverflow,
  shouldOverflowHopInsteadOfClip,
  overflowHopTaskOrder,
} from "../src/routes/gateway/overflowContextHop";
import {
  applyInputTokenLimit,
  previewInputTokenLimit,
} from "../src/routes/gateway/inputTokenLimit";
import { enforceInputTokenLimit } from "../src/routes/gateway/inputTokenLimitGuard";
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
  it("hops when group/user clipping would drop turns, even below the 1M floor", () => {
    const decision = decideGroupClipOverflow({
      droppedTurns: 9,
      originalTokens: 276348,
      hasImages: false,
    });
    expect(decision.hop).toBe(true);
    expect(decision.applyOneMillionFloor).toBe(false);
    expect(decision.preferVision).toBe(false);
    expect(276348).toBeLessThan(LONG_CONTEXT_STRATEGY_MIN_INPUT_TOKENS);
  });

  it("prefers a vision target when the unclipped request has images", () => {
    const decision = decideGroupClipOverflow({
      droppedTurns: 2,
      originalTokens: 180000,
      hasImages: true,
    });
    expect(decision.hop).toBe(true);
    expect(decision.preferVision).toBe(true);
    expect(decision.applyOneMillionFloor).toBe(false);
  });

  it("does not hop when no turns would be dropped", () => {
    expect(decideGroupClipOverflow({ droppedTurns: 0, originalTokens: 13033 }).hop).toBe(false);
    expect(shouldOverflowHopInsteadOfClip({ droppedTurns: 0, truncated: false })).toBe(false);
  });

  it("orders vision before long_context when the request has images", () => {
    expect(overflowHopTaskOrder(true)).toEqual(["vision", "long_context"]);
    expect(overflowHopTaskOrder(false)).toEqual(["long_context"]);
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
    expect(shouldOverflowHopInsteadOfClip(preview)).toBe(true);
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

describe("enforceInputTokenLimit defers clip when overflow hop is recommended", () => {
  function mockCtx(overrides: Record<string, any> = {}) {
    return {
      inputTokenLimit: { maxInputTokens: 200, source: "group", sourceLabel: "默认组" },
      routing: { incomingProtocol: "openai" },
      stream: { estimatedPromptTokens: 0 },
      overflowHopApplied: false,
      ...overrides,
    } as any;
  }

  it("does not mutate the body or log token.max_input.truncated when droppedTurns > 0", async () => {
    const body = overflowBody();
    const snapshot = JSON.stringify(body.messages);
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
      expect(result.overflowHop?.droppedTurns).toBeGreaterThan(0);
      expect(result.truncatedBody).toBeUndefined();
    }
    expect(JSON.stringify(body.messages)).toBe(snapshot);
    expect(logged.some((e) => e.code === "token.max_input.truncated")).toBe(false);
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
