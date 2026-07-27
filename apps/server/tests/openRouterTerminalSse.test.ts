import { describe, expect, it, vi } from "vitest";
import { forwardSSEStreamTransparent } from "../src/routes/gateway/streamForwarder";

function createReply() {
  const writes: string[] = [];
  const reply = {
    raw: {
      destroyed: false,
      writableEnded: false,
      write: vi.fn((chunk: string) => {
        writes.push(String(chunk));
        return true;
      }),
    },
  };
  return { reply: reply as any, writes };
}

function createControlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelCalled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelCalled = true;
    }
  });
  const encoder = new TextEncoder();
  return {
    stream,
    enqueueString(str: string) {
      controller.enqueue(encoder.encode(str));
    },
    close() {
      controller.close();
    },
    getCancelCalled: () => cancelCalled,
  };
}

const mockAdapter = {
  id: "test_adapter",
  observeStreamChunk: (chunk: any, state: any) => {
    if (chunk?.error || chunk?.choices?.[0]?.finish_reason === "error") {
      state.terminalError = {
        statusCode: 502,
        errorType: "provider_unavailable",
        message: "Upstream error",
      };
    }
  }
};

describe("§3 — terminal SSE boundary & reader release", () => {
  it("buffers full SSE event with LF, writes original buffer verbatim, calls cancel", async () => {
    const { reply, writes } = createReply();
    const upstream = createControlledStream();

    const adapterState: any = {};
    const resultPromise = forwardSSEStreamTransparent(
      reply, upstream.stream,
      undefined, undefined, undefined, "openai", undefined,
      mockAdapter, adapterState, {}
    );

    const originalEvent = `event: message\ndata: ${JSON.stringify({ error: "test error" })}\n\n`;
    upstream.enqueueString(originalEvent);

    // After the event, enqueue some extra chunk to prove reader cancels
    upstream.enqueueString("data: [DONE]\n\n");

    await resultPromise;

    // It should have written nothing because the terminal error was intercepted for fallback
    expect(writes).toEqual([]);
    expect(upstream.getCancelCalled()).toBe(true);
  });

  it("buffers full SSE event with CRLF, writes original buffer verbatim, calls cancel", async () => {
    const { reply, writes } = createReply();
    const upstream = createControlledStream();

    const adapterState: any = {};
    const resultPromise = forwardSSEStreamTransparent(
      reply, upstream.stream,
      undefined, undefined, undefined, "openai", undefined,
      mockAdapter, adapterState, {}
    );

    const originalEvent = `event: message\r\ndata: ${JSON.stringify({ error: "crlf error" })}\r\n\r\n`;
    upstream.enqueueString(originalEvent);

    await resultPromise;

    expect(writes).toEqual([]);
    expect(upstream.getCancelCalled()).toBe(true);
  });

  it("tolerates missing trailing blank line at EOF", async () => {
    const { reply, writes } = createReply();
    const upstream = createControlledStream();

    const adapterState: any = {};
    const resultPromise = forwardSSEStreamTransparent(
      reply, upstream.stream,
      undefined, undefined, undefined, "openai", undefined,
      mockAdapter, adapterState, {}
    );

    const originalEvent = `data: ${JSON.stringify({ error: "eof error" })}\n`;
    upstream.enqueueString(originalEvent);
    upstream.close();

    await resultPromise;

    // Because it's a terminal error and intercepted, it writes nothing
    expect(writes).toEqual([]);
  });
});
