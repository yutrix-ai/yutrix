import { describe, expect, it } from "vitest";
import { resolveModelContextWindow, fitsContextBudget } from "../src/routes/gateway/gatewayExecutorUtils";

describe("fallback context budget validation", () => {
  it("correctly identifies when input tokens fit or exceed model context window", () => {
    const smallModelConfig = {
      modelId: "kimi-k2.5",
      rawJson: JSON.stringify({ context_window: 98304 }),
    };

    const largeModelConfig = {
      modelId: "qwen3.7-plus",
      rawJson: JSON.stringify({ context_window: 262144 }),
    };

    const smallBudget = resolveModelContextWindow(smallModelConfig);
    const largeBudget = resolveModelContextWindow(largeModelConfig);

    expect(smallBudget.limit).toBe(98304);
    expect(largeBudget.limit).toBe(262144);

    const inputTokens = 150000;

    // Small model cannot fit 150k tokens
    expect(
      fitsContextBudget({
        inputTokens,
        requestedOutputTokens: 0,
        safetyMargin: 50,
        budget: smallBudget,
      })
    ).toBe(false);

    // Large model can fit 150k tokens
    expect(
      fitsContextBudget({
        inputTokens,
        requestedOutputTokens: 0,
        safetyMargin: 50,
        budget: largeBudget,
      })
    ).toBe(true);
  });

  it("handles unknown budget limits safely without blocking fallback", () => {
    const unknownModelConfig = {
      modelId: "custom-model",
      rawJson: null,
    };

    const budget = resolveModelContextWindow(unknownModelConfig);
    expect(budget.source).toBe("unknown");

    expect(
      fitsContextBudget({
        inputTokens: 500000,
        requestedOutputTokens: 0,
        safetyMargin: 50,
        budget,
      })
    ).toBe(true);
  });
});
