import { describe, expect, it, vi } from "vitest";
import {
  forwardSSEStreamTransparent,
  hasMeaningfulOutputEvent,
  hasVisibleAnswerEvent,
} from "../src/routes/gateway/streamForwarder";

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
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();

  return {
    stream,
    enqueueLine(line: string) {
      controller.enqueue(encoder.encode(line + "\n\n"));
    },
    close() {
      controller.close();
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("opaque SSE data vs empty-terminal withhold", () => {
  it("counts unparseable data: lines as already-sent client bytes", () => {
    expect(hasVisibleAnswerEvent("data: {choices: invalid_json}\n\n", "openai")).toBe(true);
    expect(hasMeaningfulOutputEvent("data: {choices: invalid_json}\n\n", "openai")).toBe(true);
  });

  it("does not count parseable empty-content stop as visible", () => {
    const emptyStop = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
    expect(hasVisibleAnswerEvent(emptyStop, "openai")).toBe(false);
    expect(hasMeaningfulOutputEvent(emptyStop, "openai")).toBe(false);
  });
});

describe("characterization: transparent/unmatched forwarding behavior", () => {
  it("keeps raw SSE lines byte-for-byte identical when no translator/transform matches", async () => {
    const rawSseLines = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}],\"unknown_field\":\"val\"}",
      ": comment block",
      "data: [DONE]"
    ];

    const { reply, writes } = createReply();
    const upstream = createControlledStream();

    const result = forwardSSEStreamTransparent(
      reply,
      upstream.stream,
      undefined,
      undefined,
      undefined,
      "openai",
      {
        modelId: "unmatched-model",
        providerProtocol: "openai"
      }
    );

    for (const line of rawSseLines) {
      upstream.enqueueLine(line);
      await flushMicrotasks();
    }
    upstream.close();
    await result;

    const actualOutput = writes.join("");
    const expectedOutput = rawSseLines.map(l => l + "\n\n").join("");
    expect(actualOutput).toBe(expectedOutput);
  });

  it("does not touch malformed JSON in SSE lines", async () => {
    const rawSseLines = [
      "data: {choices: invalid_json}",
      "data: [DONE]"
    ];

    const { reply, writes } = createReply();
    const upstream = createControlledStream();

    const result = forwardSSEStreamTransparent(
      reply,
      upstream.stream,
      undefined,
      undefined,
      undefined,
      "openai",
      {
        modelId: "unmatched-model",
        providerProtocol: "openai"
      }
    );

    for (const line of rawSseLines) {
      upstream.enqueueLine(line);
      await flushMicrotasks();
    }
    upstream.close();
    await result;

    const actualOutput = writes.join("");
    const expectedOutput = rawSseLines.map(l => l + "\n\n").join("");
    expect(actualOutput).toBe(expectedOutput);
  });
});
