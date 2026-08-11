import { describe, expect, it } from "vitest";
import {
  isUpstreamCredentialUnavailableError,
  processErrorRetryLogic,
  reserveAttemptBudgetForLayerSwitch,
} from "../src/routes/gateway/gatewayExecutorUtils";

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

describe("isUpstreamCredentialUnavailableError", () => {
  it("detects Antigravity / gcli2api pool-empty body", () => {
    expect(
      isUpstreamCredentialUnavailableError({
        status: 500,
        data: { error: "当前无可用凭证" },
      }),
    ).toBe(true);
  });

  it("detects English credential-pool phrasing", () => {
    expect(
      isUpstreamCredentialUnavailableError({
        status: 503,
        data: "no available credentials",
      }),
    ).toBe(true);
  });

  it("does not flag generic 5xx or unrelated errors", () => {
    expect(
      isUpstreamCredentialUnavailableError({
        status: 500,
        data: { error: "internal" },
      }),
    ).toBe(false);
    expect(
      isUpstreamCredentialUnavailableError({
        status: 200,
        data: { error: "当前无可用凭证" },
      }),
    ).toBe(false);
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

  it("does not same-key retry on 当前无可用凭证 so funnel can fall through immediately", async () => {
    const triedKeys = new Set<string>();
    const result = await processErrorRetryLogic({
      responseData: { isStream: false, status: 500, data: { error: "当前无可用凭证" } },
      activeKeyId: "key-1",
      availableKeys: [{ id: "key-1" }],
      triedKeys,
      attemptCount: 1,
      maxAttempts: 5,
    });

    expect(result).toEqual({
      shouldRetrySameProvider: false,
      preserveAttemptCount: false,
      isAuthenticationError: false,
      reason: undefined,
    });
    // Active key is still marked tried so we do not re-select it if more keys appear later.
    expect(triedKeys.has("key-1")).toBe(true);
  });

  it("still rotates keys when credential-unavailable and other keys remain", async () => {
    const triedKeys = new Set<string>();
    const result = await processErrorRetryLogic({
      responseData: { isStream: false, status: 500, data: { error: "当前无可用凭证" } },
      activeKeyId: "key-1",
      availableKeys: [{ id: "key-1" }, { id: "key-2" }],
      triedKeys,
      attemptCount: 1,
      maxAttempts: 5,
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
