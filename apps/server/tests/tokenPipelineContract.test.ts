/**
 * Token Pipeline Contract Tests
 * 
 * These tests encode the DEFINITIVE token handling behavior as a contract.
 * Any change to these behaviors must be intentional and reviewed.
 * 
 * ## Input Token Pipeline (controls prompt length)
 * 
 * ```
 * Request enters
 *   ↓
 * ① User group input limit (enforceInputTokenLimit)
 *    → Exceeds group/user maxInputTokens → Smart truncation (drop oldest turns)
 *    → Under limit or unlimited → Pass through
 *   ↓
 * ② Strategy routing (classifyTask)
 *    → Classify as vision/debug/code/long_context/writing/general
 *    → Route to corresponding task model
 *   ↓
 * ③ Long Context Override
 *    → Estimate input tokens
 *    → Exceeds current model's maxOutputTokens → Route to Long Context model
 *    → Under limit → Stay on original model
 *   ↓
 * ④ Send to upstream
 * ```
 * 
 * ## Output Token Pipeline (controls max_tokens parameter)
 * 
 * ```
 * transformRequestBody
 *   → maxOutputTokens not configured (= 0) → Full passthrough
 *   → maxOutputTokens configured (> 0):
 *     → Client didn't send max_tokens       → Inject as maxOutputTokens
 *     → Client sent value > maxOutputTokens  → Override to maxOutputTokens
 *     → Client sent value ≤ maxOutputTokens  → Keep as-is
 * ```
 * 
 * The two pipelines are fully independent.
 */

import { describe, expect, it } from "vitest";
import { applyInputTokenLimit } from "../src/routes/gateway/inputTokenLimit";
import { transformRequestBody } from "../src/routes/gateway/payload";
import { resolveModelContextWindow, fitsContextBudget } from "../src/routes/gateway/gatewayExecutorUtils";

// ============================================================================
// Contract Group 1: User Group Input Token Limit (Pipeline Step ①)
// ============================================================================

describe("Contract: User group input token limit (Step ①)", () => {
  it("truncates input when token count exceeds user group limit", async () => {
    const body = {
      model: "test-model",
      messages: [
        { role: "system", content: "System prompt." },
        { role: "user", content: "old message ".repeat(500) },
        { role: "assistant", content: "old reply" },
        { role: "user", content: "latest message" },
      ],
    };

    const result = await applyInputTokenLimit(body, {
      maxInputTokens: 100,
      modelId: "test-model",
      providerProtocol: "openai",
    });

    expect(result.truncated).toBe(true);
    expect(result.droppedTurns).toBeGreaterThan(0);
    // Latest user message must be preserved
    expect(body.messages.some((m: any) => m.content === "latest message")).toBe(true);
  });

  it("does NOT truncate when under the limit", async () => {
    const body = {
      model: "test-model",
      messages: [
        { role: "system", content: "Short system." },
        { role: "user", content: "Hello" },
      ],
    };

    const result = await applyInputTokenLimit(body, {
      maxInputTokens: 10000,
      modelId: "test-model",
      providerProtocol: "openai",
    });

    expect(result.truncated).toBe(false);
    expect(body.messages).toHaveLength(2);
  });

  it("does NOT truncate when limit is 0 (unlimited)", async () => {
    const body = {
      model: "test-model",
      messages: [
        { role: "user", content: "very long ".repeat(5000) },
      ],
    };

    const result = await applyInputTokenLimit(body, {
      maxInputTokens: 0,
      modelId: "test-model",
      providerProtocol: "openai",
    });

    // maxInputTokens=0 means no limit, should pass through unchanged
    expect(result.truncated).toBe(false);
  });
});

// ============================================================================
// Contract Group 2: Long Context Override (Pipeline Step ③)
// ============================================================================

describe("Contract: Long Context Override decision logic (Step ③)", () => {
  it("resolveModelContextWindow uses maxOutputTokens as context window fallback", () => {
    const modelConfig = {
      maxOutputTokens: 202752,
      contextWindowTokens: null,
    };
    const budget = resolveModelContextWindow(modelConfig);
    expect(budget.limit).toBe(202752);
    expect(budget.kind).toBe("total_context");
    expect(budget.source).toBe("maxOutputTokens");
  });

  it("resolveModelContextWindow prefers contextWindowTokens from rawJson when explicitly set", () => {
    const modelConfig = {
      maxOutputTokens: 8192,
      rawJson: JSON.stringify({ contextWindowTokens: 1000000 }),
    };
    const budget = resolveModelContextWindow(modelConfig);
    expect(budget.limit).toBe(1000000);
    expect(budget.kind).toBe("total_context");
    expect(budget.source).toBe("contextWindowTokens");
  });

  it("resolveModelContextWindow returns limit=0 when no config", () => {
    const budget = resolveModelContextWindow(null);
    expect(budget.limit).toBe(0);
    expect(budget.source).toBe("unknown");
  });

  it("fitsContextBudget returns false when input exceeds total_context budget", () => {
    const fits = fitsContextBudget({
      inputTokens: 200000,
      requestedOutputTokens: 8192,
      safetyMargin: 50,
      budget: { limit: 202752, kind: "total_context", source: "maxOutputTokens" },
    });
    // 200000 + 8192 + 50 = 208242 > 202752
    expect(fits).toBe(false);
  });

  it("fitsContextBudget returns true when input fits within budget", () => {
    const fits = fitsContextBudget({
      inputTokens: 100000,
      requestedOutputTokens: 8192,
      safetyMargin: 50,
      budget: { limit: 202752, kind: "total_context", source: "maxOutputTokens" },
    });
    // 100000 + 8192 + 50 = 108242 < 202752
    expect(fits).toBe(true);
  });

  it("fitsContextBudget allows ANY size when budget is unknown (limit=0)", () => {
    const fits = fitsContextBudget({
      inputTokens: 999999,
      requestedOutputTokens: 999999,
      safetyMargin: 50,
      budget: { limit: 0, kind: "total_context", source: "unknown" },
    });
    // Unknown budget → always fits (user's model, user's responsibility)
    expect(fits).toBe(true);
  });

  it("fitsContextBudget uses input-only comparison for max_input kind", () => {
    // When kind is max_input (from contextWindowTokens), only input + margin matters
    const fits = fitsContextBudget({
      inputTokens: 500000,
      requestedOutputTokens: 999999, // ignored for max_input kind
      safetyMargin: 50,
      budget: { limit: 1000000, kind: "max_input", source: "contextWindowTokens" },
    });
    // 500000 + 50 = 500050 < 1000000
    expect(fits).toBe(true);
  });
});

// ============================================================================
// Contract Group 3: max_tokens Output Pipeline (Independent)
// ============================================================================

describe("Contract: max_tokens output pipeline (independent from input)", () => {
  const noopLogAction = () => {};
  const baseActionLog = { requestId: "test" } as any;

  it("injects max_tokens when client does not send it and maxOutputTokens is configured", () => {
    const body = {
      model: "test-model",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
      // NO max_tokens field
    };

    const { modifiedBody } = transformRequestBody(
      body, "test-model", false, 8192, noopLogAction, baseActionLog, "test-provider"
    );

    expect(modifiedBody.max_tokens).toBe(8192);
  });

  it("clamps max_tokens when client sends value exceeding maxOutputTokens", () => {
    const body = {
      model: "test-model",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
      max_tokens: 99999,
    };

    const { modifiedBody } = transformRequestBody(
      body, "test-model", false, 8192, noopLogAction, baseActionLog, "test-provider"
    );

    expect(modifiedBody.max_tokens).toBe(8192);
  });

  it("preserves max_tokens when client sends value within maxOutputTokens", () => {
    const body = {
      model: "test-model",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
      max_tokens: 4096,
    };

    const { modifiedBody } = transformRequestBody(
      body, "test-model", false, 8192, noopLogAction, baseActionLog, "test-provider"
    );

    expect(modifiedBody.max_tokens).toBe(4096);
  });

  it("does NOT touch max_tokens when maxOutputTokens is 0 (passthrough)", () => {
    const body = {
      model: "test-model",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
      max_tokens: 99999,
    };

    const { modifiedBody } = transformRequestBody(
      body, "test-model", false, 0, noopLogAction, baseActionLog, "test-provider"
    );

    // maxOutputTokens=0 means full passthrough
    expect(modifiedBody.max_tokens).toBe(99999);
  });

  it("does NOT touch max_tokens when maxOutputTokens is null", () => {
    const body = {
      model: "test-model",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
      max_tokens: 50000,
    };

    const { modifiedBody } = transformRequestBody(
      body, "test-model", false, null, noopLogAction, baseActionLog, "test-provider"
    );

    expect(modifiedBody.max_tokens).toBe(50000);
  });

  it("also clamps max_completion_tokens when it exceeds maxOutputTokens", () => {
    const body = {
      model: "test-model",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
      max_completion_tokens: 99999,
    };

    const { modifiedBody } = transformRequestBody(
      body, "test-model", false, 8192, noopLogAction, baseActionLog, "test-provider"
    );

    expect(modifiedBody.max_completion_tokens).toBe(8192);
  });
});

// ============================================================================
// Contract Group 4: Pipeline Independence
// ============================================================================

describe("Contract: Input and output pipelines are independent", () => {
  const noopLogAction = () => {};
  const baseActionLog = { requestId: "test" } as any;

  it("input truncation does NOT affect max_tokens parameter", async () => {
    const body = {
      model: "test-model",
      messages: [
        { role: "user", content: "old message ".repeat(500) },
        { role: "user", content: "latest" },
      ],
      max_tokens: 4096,
    };

    // Step 1: Input truncation
    const result = await applyInputTokenLimit(body, {
      maxInputTokens: 100,
      modelId: "test-model",
      providerProtocol: "openai",
    });

    // max_tokens is untouched by input truncation
    expect(body.max_tokens).toBe(4096);
    expect(result.truncated).toBe(true);
  });

  it("max_tokens clamping does NOT affect message content", () => {
    const body = {
      model: "test-model",
      messages: [
        { role: "user", content: "very long content ".repeat(100) },
      ],
      stream: false,
      max_tokens: 99999,
    };

    const originalContent = body.messages[0].content;

    const { modifiedBody } = transformRequestBody(
      body, "test-model", false, 8192, noopLogAction, baseActionLog, "test-provider"
    );

    // max_tokens was clamped
    expect(modifiedBody.max_tokens).toBe(8192);
    // But message content is completely unchanged
    expect(modifiedBody.messages[0].content).toBe(originalContent);
  });
});

// ============================================================================
// Contract Group 5: No Physical Truncation at Gateway Layer
// ============================================================================

describe("Contract: Gateway MUST NOT silently truncate beyond user group limit", () => {
  it("applyInputTokenLimit with maxInputTokens=0 never truncates regardless of body size", async () => {
    // This test ensures the gateway does not have a hidden secondary truncation
    // mechanism. Only the user group limit (enforceInputTokenLimit) and the
    // long context override routing should affect the request body.
    // There must be NO 'physical context window enforcement' that silently
    // drops user data after strategy routing.
    const body = {
      model: "test-model",
      messages: [
        { role: "system", content: "System prompt" },
        // Simulate a massive conversation with 500+ turns
        ...Array.from({ length: 100 }, (_, i) => [
          { role: "user", content: `Turn ${i}: ${"content ".repeat(100)}` },
          { role: "assistant", content: `Response ${i}: ${"reply ".repeat(50)}` },
        ]).flat(),
        { role: "user", content: "latest user message" },
      ],
    };

    const originalMessageCount = body.messages.length;

    const result = await applyInputTokenLimit(body, {
      maxInputTokens: 0, // No limit
      modelId: "test-model",
      providerProtocol: "openai",
    });

    // With maxInputTokens=0, absolutely nothing should be truncated
    expect(result.truncated).toBe(false);
    expect(body.messages).toHaveLength(originalMessageCount);
  });
});
