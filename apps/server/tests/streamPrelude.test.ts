import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STREAM_PRELUDE_INTERVAL_MS,
  startStreamPrelude,
} from "../src/routes/gateway/streamPrelude";
import { writeStreamErrorResponse } from "../src/routes/gateway/streamProtocol";

function createReply() {
  const writes: string[] = [];
  let statusCode = 0;
  let headers: Record<string, string> = {};
  const raw = {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    writeHead: vi.fn((status: number, h: Record<string, string>) => {
      statusCode = status;
      headers = h;
      raw.headersSent = true;
    }),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }),
    end: vi.fn(() => {
      raw.writableEnded = true;
    }),
  };

  return {
    reply: { raw } as any,
    writes,
    get statusCode() {
      return statusCode;
    },
    get headers() {
      return headers;
    },
  };
}

describe("stream prelude", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts an OpenAI-compatible SSE response before upstream sends headers", async () => {
    vi.useFakeTimers();
    const harness = createReply();
    const { reply, writes } = harness;

    const stop = startStreamPrelude(reply, "openai");

    expect(harness.statusCode).toBe(200);
    expect(harness.headers["Content-Type"]).toBe("text/event-stream");
    expect(reply.raw.flushHeaders).toHaveBeenCalledOnce();
    expect(writes).toEqual([":\n\n"]);

    await vi.advanceTimersByTimeAsync(STREAM_PRELUDE_INTERVAL_MS);
    expect(writes).toEqual([":\n\n", ":\n\n"]);

    stop();
    await vi.advanceTimersByTimeAsync(STREAM_PRELUDE_INTERVAL_MS);
    expect(writes).toHaveLength(2);
  });

  it("uses Anthropic ping events for Anthropic streams", () => {
    vi.useFakeTimers();
    const { reply, writes } = createReply();

    const stop = startStreamPrelude(reply, "anthropic");

    expect(writes[0]).toBe(`event: ping\ndata: {"type":"ping"}\n\n`);
    stop();
  });

  it("can open an Anthropic message before an adapted upstream responds", () => {
    vi.useFakeTimers();
    const { reply, writes } = createReply();

    const stop = startStreamPrelude(reply, "anthropic", {
      anthropicMessage: {
        messageId: "msg_early",
        modelId: "gemma-4-31b-it",
        promptTokens: 0,
      },
    });

    expect(writes[0]).toContain("event: message_start");
    expect(writes[0]).toContain("\"id\":\"msg_early\"");
    expect((reply.raw as any).__promptgateAnthropicMessageStarted).toBe(true);
    stop();
  });

  it("writes OpenAI-compatible SSE errors after stream headers are sent", () => {
    const { reply, writes } = createReply();

    startStreamPrelude(reply, "openai")();
    writeStreamErrorResponse(reply, "openai", 504, "upstream timeout");

    expect(writes.join("")).toContain("\"message\":\"upstream timeout\"");
    expect(writes.join("")).toContain("\"code\":\"504\"");
    // expect(writes.join("")).toContain("data: [DONE]\n\n");
    expect(reply.raw.end).toHaveBeenCalledOnce();
  });
});
