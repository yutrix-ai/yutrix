import { describe, expect, it } from "vitest";
import { processErrorRetryLogic, reserveAttemptBudgetForLayerSwitch } from "../src/routes/gateway/gatewayExecutorUtils";

describe("reserveAttemptBudgetForLayerSwitch", () => {
  it("does not change attemptCount when budget remains (early fallback paths)", () => {
    expect(reserveAttemptBudgetForLayerSwitch(1, 6)).toBe(1);
    expect(reserveAttemptBudgetForLayerSwitch(5, 6)).toBe(5);
  });

  it("frees one slot when attemptCount is already exhausted so L1 can run", () => {
    expect(reserveAttemptBudgetForLayerSwitch(6, 6)).toBe(5);
    expect(reserveAttemptBudgetForLayerSwitch(7, 6)).toBe(5);
  });

  it("handles edge maxAttempts values safely", () => {
    expect(reserveAttemptBudgetForLayerSwitch(0, 0)).toBe(0);
    expect(reserveAttemptBudgetForLayerSwitch(1, 1)).toBe(0);
  });
});

describe("gateway executor retry logic", () => {
  it("retries transient upstream 5xx with the same provider key when attempts remain", async () => {
    const triedKeys = new Set<string>();
    const result = await processErrorRetryLogic({
      responseData: { isStream: false, status: 500, data: { error: "internal" } },
      activeKeyId: "key-1",
      availableKeys: [{ id: "key-1" }],
      triedKeys,
      attemptCount: 1,
      maxAttempts: 4,
    });

    expect(result).toEqual({
      shouldRetrySameProvider: true,
      preserveAttemptCount: false,
      isAuthenticationError: false,
      reason: "transient_upstream_5xx",
    });
    expect(triedKeys.has("key-1")).toBe(false);
  });

  it("does not retry transient upstream 5xx after attempts are exhausted", async () => {
    const result = await processErrorRetryLogic({
      responseData: { isStream: false, status: 500, data: { error: "internal" } },
      activeKeyId: "key-1",
      availableKeys: [{ id: "key-1" }],
      triedKeys: new Set<string>(),
      attemptCount: 4,
      maxAttempts: 4,
    });

    expect(result).toEqual({
      shouldRetrySameProvider: false,
      preserveAttemptCount: false,
      isAuthenticationError: false,
      reason: undefined,
    });
  });

  it("preserves attempt count when rotating across multiple provider keys", async () => {
    const triedKeys = new Set<string>();
    const result = await processErrorRetryLogic({
      responseData: { isStream: false, status: 500, data: { error: "internal" } },
      activeKeyId: "key-1",
      availableKeys: [{ id: "key-1" }, { id: "key-2" }],
      triedKeys,
      attemptCount: 1,
      maxAttempts: 4,
    });

    expect(result).toEqual({
      shouldRetrySameProvider: true,
      preserveAttemptCount: true,
      isAuthenticationError: false,
      reason: "provider_key_rotation",
    });
    expect(triedKeys.has("key-1")).toBe(true);
  });
});
