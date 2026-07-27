import { describe, expect, it, vi } from "vitest";
import { forwardSSEStreamTransparent, StitchState } from "../src/routes/gateway/streamForwarder";

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
    enqueueEvent(eventStr: string) {
      controller.enqueue(encoder.encode(eventStr));
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

describe("Transparent SSE Byte Equality & Usage Buffering", () => {
  it("Case A: Normal usage then stop then DONE preserves exact bytes", async () => {
    const rawEvents = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\n\n",
      "data: {\"usage\":{\"prompt\":1}}\n\n",
      "data: {\"choices\":[{\"finish_reason\":\"stop\"}]}\n\n",
      "data: [DONE]\n\n"
    ];

    const { reply, writes } = createReply();
    const upstream = createControlledStream();

    const stitchState: StitchState = {
      isStitching: false,
      insideToolCall: false,
      toolCallIndex: 0,
      toolCallId: "",
      toolCallName: ""
    };

    const resultPromise = forwardSSEStreamTransparent(
      reply,
      upstream.stream,
      undefined,
      stitchState,
      undefined,
      "openai", // incomingProtocol
      undefined,
      { id: "transparent" }, // adapter
      {}, // adapterState
      {}, // adapterContext
      undefined,
      undefined,
      "openai" // sourceProtocol
    );

    for (const ev of rawEvents) {
      upstream.enqueueEvent(ev);
      await flushMicrotasks();
    }
    upstream.close();
    await resultPromise;

    const actualOutput = writes.join("");
    expect(actualOutput).toBe(rawEvents.join(""));
  });

  it("Case B: Usage then length then DONE (Cutoff drops usage, length, DONE)", async () => {
    const rawEvents = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\n\n",
      "data: {\"usage\":{\"prompt\":1}}\n\n",
      "data: {\"choices\":[{\"finish_reason\":\"length\"}]}\n\n",
      "data: [DONE]\n\n"
    ];

    const { reply, writes } = createReply();
    const upstream = createControlledStream();
    
    const stitchState: StitchState = {
      isStitching: false,
      insideToolCall: false,
      toolCallIndex: 0,
      toolCallId: "",
      toolCallName: ""
    };

    const resultPromise = forwardSSEStreamTransparent(
      reply,
      upstream.stream,
      undefined,
      stitchState,
      undefined,
      "openai",
      undefined,
      { id: "transparent" },
      {},
      {},
      undefined,
      undefined,
      "openai"
    );

    for (const ev of rawEvents) {
      upstream.enqueueEvent(ev);
      await flushMicrotasks();
    }
    upstream.close();
    const result = await resultPromise;

    const actualOutput = writes.join("");
    // Should only output the first event!
    expect(actualOutput).toBe("data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\n\n");
    expect(result.isLengthTruncated).toBe(true);
  });

  it("Case D: content+usage in same chunk with length (Strips usage/length, sends content)", async () => {
    const ev1 = "data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\n\n";
    // Note: spaces/newlines inside json matter for byte equality test if it wasn't modified.
    // But since it's modified, it will stringify.
    const ev2 = "data: {\"choices\":[{\"delta\":{\"content\":\"B\"},\"finish_reason\":\"length\"}],\"usage\":{\"prompt\":1}}\n\n";
    const ev3 = "data: [DONE]\n\n";

    const { reply, writes } = createReply();
    const upstream = createControlledStream();
    
    const stitchState: StitchState = {
      isStitching: false,
      insideToolCall: false,
      toolCallIndex: 0,
      toolCallId: "",
      toolCallName: ""
    };

    const resultPromise = forwardSSEStreamTransparent(
      reply,
      upstream.stream,
      undefined,
      stitchState,
      undefined,
      "openai",
      undefined,
      { id: "transparent" },
      {},
      {},
      undefined,
      undefined,
      "openai"
    );

    upstream.enqueueEvent(ev1);
    await flushMicrotasks();
    upstream.enqueueEvent(ev2);
    await flushMicrotasks();
    upstream.enqueueEvent(ev3);
    await flushMicrotasks();
    upstream.close();
    
    const result = await resultPromise;

    const actualOutput = writes.join("");
    // Should contain ev1, and a modified ev2 (no usage, no finish_reason), and no DONE.
    expect(actualOutput).toContain(ev1);
    expect(actualOutput).not.toContain("usage");
    expect(actualOutput).not.toContain("length");
    expect(actualOutput).toContain("\"content\":\"B\"");
    expect(actualOutput).not.toContain("[DONE]");
    expect(result.isLengthTruncated).toBe(true);
  });

  it("Case E: content+usage in same chunk with stop (Byte equality preserved)", async () => {
    const rawEvents = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"B\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt\":1}}\n\n",
      "data: [DONE]\n\n"
    ];

    const { reply, writes } = createReply();
    const upstream = createControlledStream();
    
    const stitchState: StitchState = {
      isStitching: false,
      insideToolCall: false,
      toolCallIndex: 0,
      toolCallId: "",
      toolCallName: ""
    };

    const resultPromise = forwardSSEStreamTransparent(
      reply,
      upstream.stream,
      undefined,
      stitchState,
      undefined,
      "openai",
      undefined,
      { id: "transparent" },
      {},
      {},
      undefined,
      undefined,
      "openai"
    );

    for (const ev of rawEvents) {
      upstream.enqueueEvent(ev);
      await flushMicrotasks();
    }
    upstream.close();
    
    await resultPromise;

    const actualOutput = writes.join("");
    // Should perfectly match rawEvents bytes!
    expect(actualOutput).toBe(rawEvents.join(""));
  });

  it("Case F: usage followed by EOF without DONE is flushed", async () => {
    const rawEvents = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\n\n",
      "data: {\"usage\":{\"prompt\":1}}\n\n"
      // Stream terminates here
    ];

    const { reply, writes } = createReply();
    const upstream = createControlledStream();
    
    const stitchState: StitchState = {
      isStitching: false,
      insideToolCall: false,
      toolCallIndex: 0,
      toolCallId: "",
      toolCallName: ""
    };

    const resultPromise = forwardSSEStreamTransparent(
      reply,
      upstream.stream,
      undefined,
      stitchState,
      undefined,
      "openai",
      undefined,
      { id: "transparent" },
      {},
      {},
      undefined,
      undefined,
      "openai"
    );

    for (const ev of rawEvents) {
      upstream.enqueueEvent(ev);
      await flushMicrotasks();
    }
    upstream.close();
    
    await resultPromise;

    const actualOutput = writes.join("");
    // Should parfaitement match rawEvents bytes! The usage chunk should not be dropped.
    expect(actualOutput).toBe(rawEvents.join(""));
  });

  it("Case G: comment and usage followed by EOF without DONE is flushed", async () => {
    const rawEvents = [
      ": keep-alive comment\n\n",
      "data: {\"usage\":{\"prompt\":2}}\n\n"
      // Stream terminates here
    ];

    const { reply, writes } = createReply();
    const upstream = createControlledStream();
    
    const stitchState: StitchState = {
      isStitching: false,
      insideToolCall: false,
      toolCallIndex: 0,
      toolCallId: "",
      toolCallName: ""
    };

    const resultPromise = forwardSSEStreamTransparent(
      reply,
      upstream.stream,
      undefined,
      stitchState,
      undefined,
      "openai",
      undefined,
      { id: "transparent" },
      {},
      {},
      undefined,
      undefined,
      "openai"
    );

    for (const ev of rawEvents) {
      upstream.enqueueEvent(ev);
      await flushMicrotasks();
    }
    upstream.close();
    
    await resultPromise;

    const actualOutput = writes.join("");
    // Should parfaitement match rawEvents bytes!
    expect(actualOutput).toBe(rawEvents.join(""));
  });
});
