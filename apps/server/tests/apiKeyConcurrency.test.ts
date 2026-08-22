import { describe, it, expect } from "vitest";
import {
  FACTORY_DEFAULT_API_KEY_CONCURRENCY,
  concurrencyLimitForNewUserKey,
  parseDefaultApiKeyConcurrency,
} from "../src/services/apiKeyConcurrency";

describe("factory default API key concurrency", () => {
  it("is in the agent-friendly 8–16 range", () => {
    expect(FACTORY_DEFAULT_API_KEY_CONCURRENCY).toBeGreaterThanOrEqual(8);
    expect(FACTORY_DEFAULT_API_KEY_CONCURRENCY).toBeLessThanOrEqual(16);
  });

  it("is used when the stored setting is missing or invalid", () => {
    expect(parseDefaultApiKeyConcurrency(undefined)).toBe(FACTORY_DEFAULT_API_KEY_CONCURRENCY);
    expect(parseDefaultApiKeyConcurrency("")).toBe(FACTORY_DEFAULT_API_KEY_CONCURRENCY);
    expect(parseDefaultApiKeyConcurrency("nope")).toBe(FACTORY_DEFAULT_API_KEY_CONCURRENCY);
    expect(parseDefaultApiKeyConcurrency(0)).toBe(FACTORY_DEFAULT_API_KEY_CONCURRENCY);
    expect(parseDefaultApiKeyConcurrency(-1)).toBe(FACTORY_DEFAULT_API_KEY_CONCURRENCY);
  });

  it("honors a positive integer stored admin setting other than the legacy factory 2", () => {
    expect(parseDefaultApiKeyConcurrency("20")).toBe(20);
    expect(parseDefaultApiKeyConcurrency(4)).toBe(4);
  });

  it("treats the legacy factory value 2 as unset so existing installs pick up 8–16", () => {
    expect(parseDefaultApiKeyConcurrency(2)).toBe(FACTORY_DEFAULT_API_KEY_CONCURRENCY);
    expect(parseDefaultApiKeyConcurrency("2")).toBe(FACTORY_DEFAULT_API_KEY_CONCURRENCY);
  });

  it("ignores a caller-supplied concurrencyLimit when creating a user key", () => {
    expect(concurrencyLimitForNewUserKey(99, undefined)).toBe(FACTORY_DEFAULT_API_KEY_CONCURRENCY);
    expect(concurrencyLimitForNewUserKey(99, "12")).toBe(12);
    expect(concurrencyLimitForNewUserKey(1, undefined)).not.toBe(1);
  });
});
