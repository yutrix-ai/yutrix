import { describe, expect, it } from "vitest";
import { isErrorFallbackStatus } from "../src/routes/gateway/fallback";
import { getStatusReasonCN } from "../src/utils/gatewayError";

describe("isErrorFallbackStatus", () => {
  it("treats only HTTP 200 as a successful terminal status", () => {
    expect(isErrorFallbackStatus(200)).toBe(false);
  });

  it("hops on 404 model_not_found and other non-200 upstream statuses", () => {
    expect(isErrorFallbackStatus(404)).toBe(true);
    expect(isErrorFallbackStatus(400)).toBe(true);
    expect(isErrorFallbackStatus(401)).toBe(true);
    expect(isErrorFallbackStatus(403)).toBe(true);
    expect(isErrorFallbackStatus(429)).toBe(true);
    expect(isErrorFallbackStatus(500)).toBe(true);
    expect(isErrorFallbackStatus(502)).toBe(true);
    expect(isErrorFallbackStatus(503)).toBe(true);
    expect(isErrorFallbackStatus(0)).toBe(true);
    expect(isErrorFallbackStatus(undefined)).toBe(true);
  });
});

describe("getStatusReasonCN", () => {
  it("labels 404 as an unavailable upstream model", () => {
    expect(getStatusReasonCN(404)).toBe("上游模型不可用");
  });
});
