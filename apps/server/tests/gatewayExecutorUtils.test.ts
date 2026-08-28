import { describe, expect, it } from "vitest";
import {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  isAvailabilityHopStatus,
  isUpstreamCredentialUnavailableError,
  processErrorRetryLogic,
  remainingFirstChunkTimeoutMs,
  reserveAttemptBudgetForLayerSwitch,
  resolveUpstreamTimeoutMs,
} from "../src/routes/gateway/gatewayExecutorUtils";

describe("availability hop statuses", () => {
  it("treats 502/503/504/529 as availability hops and 500/429 as not", () => {
    expect(isAvailabilityHopStatus(502)).toBe(true);
    expect(isAvailabilityHopStatus(503)).toBe(true);
    expect(isAvailabilityHopStatus(504)).toBe(true);
    expect(isAvailabilityHopStatus(529)).toBe(true);
    expect(isAvailabilityHopStatus(500)).toBe(false);
    expect(isAvailabilityHopStatus(429)).toBe(false);
  });
});

describe("resolveUpstreamTimeoutMs", () => {
  it("uses the configured timeout when positive", () => {
    expect(resolveUpstreamTimeoutMs(15000)).toBe(15000);
  });

  it("falls back to 60s when timeout is 0/unset so undici cannot wait 300s", () => {
    expect(resolveUpstreamTimeoutMs(0)).toBe(DEFAULT_UPSTREAM_TIMEOUT_MS);
    expect(resolveUpstreamTimeoutMs(undefined)).toBe(DEFAULT_UPSTREAM_TIMEOUT_MS);
    expect(resolveUpstreamTimeoutMs(null)).toBe(DEFAULT_UPSTREAM_TIMEOUT_MS);
    expect(DEFAULT_UPSTREAM_TIMEOUT_MS).toBe(60_000);
  });
});

describe("remainingFirstChunkTimeoutMs", () => {
  it("is unset when timeoutMs is 0 so existing configs do not gain a first-answer SLA", () => {
    expect(remainingFirstChunkTimeoutMs(0, 10)).toBeUndefined();
    expect(remainingFirstChunkTimeoutMs(undefined, 10)).toBeUndefined();
    expect(remainingFirstChunkTimeoutMs(null, 0)).toBeUndefined();
  });

  it("returns remaining budget from the no-answer deadline and floors at 1ms", () => {
    expect(remainingFirstChunkTimeoutMs(10000, 2500)).toBe(7500);
    expect(remainingFirstChunkTimeoutMs(10000, 0)).toBe(10000);
    expect(remainingFirstChunkTimeoutMs(10000, 10000)).toBe(1);
    expect(remainingFirstChunkTimeoutMs(10000, 15000)).toBe(1);
  });
});

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

  it("does not same-key retry or rotate keys on 504 so funnel can hop immediately", async () => {
    const triedKeys = new Set<string>();
    const result = await processErrorRetryLogic({
      responseData: { isStream: false, status: 504, data: { error: "headers timeout" } },
      activeKeyId: "key-1",
      availableKeys: [{ id: "key-1" }, { id: "key-2" }],
      triedKeys,
      attemptCount: 1,
      maxAttempts: 6,
    });

    expect(result).toEqual({
      shouldRetrySameProvider: false,
      preserveAttemptCount: false,
      isAuthenticationError: false,
      reason: undefined,
    });
    expect(triedKeys.size).toBe(0);
  });

  it("does not same-key retry on 529 overloaded so funnel can hop immediately", async () => {
    const result = await processErrorRetryLogic({
      responseData: {
        isStream: false,
        status: 529,
        data: { message: "Service temporarily overloaded", type: "Overloaded", code: 529 },
      },
      activeKeyId: "key-1",
      availableKeys: [{ id: "key-1" }],
      triedKeys: new Set<string>(),
      attemptCount: 1,
      maxAttempts: 4,
    });

    expect(result.shouldRetrySameProvider).toBe(false);
  });

  it("does not same-key retry or rotate keys on 502/503 availability failures", async () => {
    for (const status of [502, 503]) {
      const triedKeys = new Set<string>();
      const result = await processErrorRetryLogic({
        responseData: { isStream: false, status, data: { error: "bad gateway" } },
        activeKeyId: "key-1",
        availableKeys: [{ id: "key-1" }, { id: "key-2" }],
        triedKeys,
        attemptCount: 1,
        maxAttempts: 6,
      });
      expect({ status, shouldRetrySameProvider: result.shouldRetrySameProvider }).toEqual({
        status,
        shouldRetrySameProvider: false,
      });
      expect({ status, tried: triedKeys.size }).toEqual({ status, tried: 0 });
    }
  });

  it("still rotates keys on 503 credential-unavailable rather than treating it as a blind availability hop", async () => {
    const triedKeys = new Set<string>();
    const result = await processErrorRetryLogic({
      responseData: { isStream: false, status: 503, data: "no available credentials" },
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

  it("still rotates keys on 429 before any funnel hop", async () => {
    const triedKeys = new Set<string>();
    const result = await processErrorRetryLogic({
      responseData: { isStream: false, status: 429, data: { error: "rate limit" } },
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
