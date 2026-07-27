import { describe, expect, it } from "vitest";
import {
  formatStreamErrorEvent,
  formatStreamKeepAlive,
  streamHeaders,
} from "../src/routes/gateway/streamProtocol";

describe("stream protocol framing", () => {
  it("centralizes protocol-specific keep-alive frames", () => {
    expect(formatStreamKeepAlive("openai")).toBe(":\n\n");
    expect(formatStreamKeepAlive("anthropic")).toBe(`event: ping\ndata: {"type":"ping"}\n\n`);
  });

  it("centralizes OpenAI-compatible stream error framing", () => {
    expect(formatStreamErrorEvent("openai", 504, "idle", { code: "stream_timeout" })).toBe(
      `data: {"error":{"message":"idle","type":"server_error","code":"stream_timeout"}}\n\n`,
    );
  });

  it("centralizes Anthropic stream error framing", () => {
    expect(formatStreamErrorEvent("anthropic", 504, "idle")).toBe(
      `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"idle"}}\n\n`,
    );
  });

  it("centralizes Anthropic stream error framing with canonicalErrorType", () => {
    expect(
      formatStreamErrorEvent("anthropic", 529, "Overloaded", {
        type: "overloaded_error",
        canonicalErrorType: "provider_overloaded",
      }),
    ).toBe(
      `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded","error_type":"provider_overloaded"}}\n\n`,
    );
  });

  it("uses no-transform SSE headers for all gateway streams", () => {
    expect(streamHeaders()).toEqual({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
  });
});
