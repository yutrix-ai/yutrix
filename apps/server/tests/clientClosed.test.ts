import { describe, expect, it } from "vitest";
import { classifyUpstreamErrorWithAdapter } from "../src/routes/gateway/streamForwarder";
import {
  CLIENT_CLOSED_CODE,
  CLIENT_CLOSED_ERROR_TYPE,
  CLIENT_CLOSED_RETRY_CLASS,
  CLIENT_CLOSED_STATUS,
  DOWNSTREAM_CONNECTION_CLOSED_MESSAGE,
  FIRST_TOKEN_TIMEOUT_MESSAGE,
  STREAM_CHUNK_TIMEOUT_MESSAGE,
  shouldSkipUpstreamRescue,
} from "../src/routes/gateway/clientClosed";
import { isAvailabilityHopStatus } from "../src/routes/gateway/gatewayExecutorUtils";
import { renderActionLogServerLine } from "../src/utils/actionLogTemplates";

function classify(rawError: unknown, statusCode?: number, phase: "http" | "nonstream" | "fake_stream" | "stream" = "stream") {
  return classifyUpstreamErrorWithAdapter(
    { id: "transparent" },
    { rawError, statusCode, phase },
    { providerName: "Antigravity_US1" },
  );
}

describe("default stream-error classifier: client-closed vs availability", () => {
  it("classifies Downstream connection closed as non-retryable client-closed, not 502/upstream_error", () => {
    const terminal = classify(new Error(DOWNSTREAM_CONNECTION_CLOSED_MESSAGE), 502);

    expect(terminal.statusCode).toBe(CLIENT_CLOSED_STATUS);
    expect(terminal.code).toBe(CLIENT_CLOSED_CODE);
    expect(terminal.errorType).toBe(CLIENT_CLOSED_ERROR_TYPE);
    expect(terminal.retryClass).toBe(CLIENT_CLOSED_RETRY_CLASS);
    expect(terminal.retryable).toBe(false);
    expect(terminal.message).toBe(DOWNSTREAM_CONNECTION_CLOSED_MESSAGE);
    expect(terminal.statusCode).not.toBe(502);
    expect(terminal.errorType).not.toBe("upstream_error");
    expect(isAvailabilityHopStatus(terminal.statusCode)).toBe(false);
    expect(shouldSkipUpstreamRescue({ terminalError: terminal })).toBe(true);
  });

  it("classifies abort-after-disconnect (499 + AbortError) as client-closed", () => {
    const abortErr = new DOMException("The operation was aborted.", "AbortError");
    const terminal = classify(abortErr, 499);

    expect(terminal.statusCode).toBe(CLIENT_CLOSED_STATUS);
    expect(terminal.code).toBe(CLIENT_CLOSED_CODE);
    expect(terminal.errorType).toBe(CLIENT_CLOSED_ERROR_TYPE);
    expect(terminal.retryClass).toBe(CLIENT_CLOSED_RETRY_CLASS);
    expect(terminal.retryable).toBe(false);
    expect(shouldSkipUpstreamRescue({ terminalError: terminal, abortSignaled: true })).toBe(true);
  });

  it("keeps a real upstream 502 body as availability hop, not client-closed", () => {
    const terminal = classify(
      { error: { message: "Bad Gateway", type: "upstream_error", code: "upstream_error" } },
      502,
    );

    expect(terminal.statusCode).toBe(502);
    expect(terminal.errorType).toBe("upstream_error");
    expect(terminal.retryClass).not.toBe(CLIENT_CLOSED_RETRY_CLASS);
    expect(isAvailabilityHopStatus(terminal.statusCode)).toBe(true);
    expect(shouldSkipUpstreamRescue({ terminalError: terminal })).toBe(false);
  });

  it("keeps Stream chunk timeout as 504 availability hop", () => {
    const terminal = classify(new Error(STREAM_CHUNK_TIMEOUT_MESSAGE), 504);

    expect(terminal.statusCode).toBe(504);
    expect(terminal.message).toBe(STREAM_CHUNK_TIMEOUT_MESSAGE);
    expect(terminal.retryClass).not.toBe(CLIENT_CLOSED_RETRY_CLASS);
    expect(isAvailabilityHopStatus(terminal.statusCode)).toBe(true);
    expect(shouldSkipUpstreamRescue({ terminalError: terminal })).toBe(false);
  });

  it("keeps First token timeout as 504 availability hop", () => {
    const terminal = classify(new Error(FIRST_TOKEN_TIMEOUT_MESSAGE), 504);

    expect(terminal.statusCode).toBe(504);
    expect(terminal.message).toBe(FIRST_TOKEN_TIMEOUT_MESSAGE);
    expect(terminal.retryClass).not.toBe(CLIENT_CLOSED_RETRY_CLASS);
    expect(isAvailabilityHopStatus(terminal.statusCode)).toBe(true);
    expect(shouldSkipUpstreamRescue({ terminalError: terminal })).toBe(false);
  });

  it("does not treat undici timeout abort text as client-closed", () => {
    const terminal = classify(new Error("This operation was aborted"), 504);
    expect(terminal.statusCode).toBe(504);
    expect(terminal.retryClass).not.toBe(CLIENT_CLOSED_RETRY_CLASS);
    expect(shouldSkipUpstreamRescue({ terminalError: terminal })).toBe(false);
  });
});

describe("shouldSkipUpstreamRescue", () => {
  it("skips rescue when the request is already aborted even if the error still looks like 502", () => {
    expect(
      shouldSkipUpstreamRescue({
        terminalError: { statusCode: 502, errorType: "upstream_error", message: "Bad Gateway" },
        abortSignaled: true,
      }),
    ).toBe(true);
  });

  it("skips rescue when clientDisconnected is already set", () => {
    expect(
      shouldSkipUpstreamRescue({
        terminalError: { statusCode: 502, errorType: "upstream_error", message: "Bad Gateway" },
        clientDisconnected: true,
      }),
    ).toBe(true);
  });

  it("skips rescue for fetch-time 499 / client_closed", () => {
    expect(shouldSkipUpstreamRescue({ fetchStatus: 499 })).toBe(true);
  });

  it("allows rescue for a connected client with a real 504", () => {
    expect(
      shouldSkipUpstreamRescue({
        terminalError: { statusCode: 504, errorType: "upstream_error", message: STREAM_CHUNK_TIMEOUT_MESSAGE },
        clientDisconnected: false,
        abortSignaled: false,
      }),
    ).toBe(false);
  });
});

describe("client-closed action log message", () => {
  it("renders a non-empty message so the template cannot print msg=undefined", () => {
    const line = renderActionLogServerLine(
      {
        id: "1",
        timestamp: "2026-08-27 09:49:11",
        level: "INFO",
        code: "request.provider_adapter.stream_error",
        params: {},
        serverLine: "",
        requestId: "70771cfc",
        adapterId: "transparent",
        errorCode: CLIENT_CLOSED_CODE,
        errorType: CLIENT_CLOSED_ERROR_TYPE,
        message: DOWNSTREAM_CONNECTION_CLOSED_MESSAGE,
      } as any,
      "2026-08-27 09:49:11",
    );
    expect(line).toContain(`msg=${DOWNSTREAM_CONNECTION_CLOSED_MESSAGE}`);
    expect(line).not.toContain("msg=undefined");
  });
});
