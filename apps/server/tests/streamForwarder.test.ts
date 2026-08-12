import { afterEach, describe, expect, it, vi } from "vitest";
import { googleAdapter } from "../src/routes/gateway/providerAdapters/googleAdapter";
import {
  forwardSSEStreamAdapted,
  forwardSSEStreamTransparent,
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
    enqueueSse(data: any) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
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

describe("streamForwarder keep-alive", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends an early Anthropic ping while waiting for the first upstream chunk", async () => {
    vi.useFakeTimers();
    const { reply, writes } = createReply();
    const upstream = createControlledStream();

    const result = forwardSSEStreamAdapted(
      reply,
      upstream.stream,
      {
        targetProtocol: "anthropic",
        messageId: "msg_test",
        modelId: "gemma-4-31b-it",
        promptTokens: 12,
      },
    );

    expect(writes.join("")).toContain("event: message_start");

    await vi.advanceTimersByTimeAsync(3000);
    expect(writes.join("")).toContain("event: ping");

    upstream.close();
    await result;
  });

  it("does not duplicate Anthropic message_start after an early prelude message", async () => {
    const { reply, writes } = createReply();
    const upstream = createControlledStream();
    (reply.raw as any).__promptgateAnthropicMessageStarted = true;

    const result = forwardSSEStreamAdapted(
      reply,
      upstream.stream,
      {
        targetProtocol: "anthropic",
        messageId: "msg_test",
        modelId: "gemma-4-31b-it",
        promptTokens: 12,
      },
    );

    upstream.enqueueSse({
      choices: [{ delta: { content: "hello" }, finish_reason: null }],
    });
    await flushMicrotasks();
    upstream.close();
    await result;

    const output = writes.join("");
    expect(output.match(/event: message_start/g) || []).toHaveLength(0);
    expect(output).toContain("event: content_block_delta");
    expect(output).toContain("hello");
    expect(output).toContain("event: message_stop");
  });

  it("pings during hidden reasoning chunks that produce no Anthropic content block", async () => {
    vi.useFakeTimers();
    const { reply, writes } = createReply();
    const upstream = createControlledStream();

    const result = forwardSSEStreamAdapted(
      reply,
      upstream.stream,
      {
        targetProtocol: "anthropic",
        messageId: "msg_test",
        modelId: "deepseek-r1",
        promptTokens: 12,
      },
    );

    await vi.advanceTimersByTimeAsync(2600);
    upstream.enqueueSse({
      choices: [{ delta: { reasoning_content: "thinking privately" } }],
    });
    await flushMicrotasks();

    const output = writes.join("");
    expect(output).toContain("event: ping");
    expect(output).not.toContain("content_block_delta");

    upstream.close();
    await result;
  });

  it("uses SSE comments for early OpenAI-compatible transparent streams", async () => {
    vi.useFakeTimers();
    const { reply, writes } = createReply();
    const upstream = createControlledStream();

    const result = forwardSSEStreamTransparent(
      reply,
      upstream.stream,
      undefined,
      undefined,
      undefined,
      "openai",
    );

    await vi.advanceTimersByTimeAsync(3000);
    expect(writes).not.toContain(":\n\n");

    upstream.close();
    await result;
  });

  it("normalizes Google thought chunks on OpenAI-compatible transparent streams", async () => {
    const { reply, writes } = createReply();
    const upstream = createControlledStream();
    const observedChunks: any[] = [];
    const googleThoughtChunk = {
      id: "chatcmpl-google",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            content: "<thought>thinking",
            extra_content: { google: { thought: true } },
          },
          finish_reason: null,
        },
      ],
    };

    const result = forwardSSEStreamTransparent(
      reply,
      upstream.stream,
      {
        onParsedChunk(data) {
          observedChunks.push(data);
        },
      },
      undefined,
      undefined,
      "openai",
      { modelId: "gemma-4-31b-it", providerProtocol: "openai" },
      googleAdapter,
      { isInsideGoogleThoughtTag: false, isGoogleGemmaStream: false },
      { modelId: "gemma-4-31b-it", providerProtocol: "openai" } as any,
    );

    upstream.enqueueSse(googleThoughtChunk);
    await flushMicrotasks();
    upstream.close();
    const forwardResult = await result;

    const output = writes.join("");
    expect(forwardResult.gotFirstChunk).toBe(true);
    expect(output).toContain("\"reasoning_content\":\"thinking\"");
    expect(output).not.toContain("\"content\":\"<thought>thinking\"");
    expect(output).not.toContain("extra_content");
    expect(observedChunks[0].choices[0].delta.reasoning_content).toBe("thinking");
    expect(observedChunks[0].choices[0].delta.content).toBeUndefined();
  });

  it("splits Google thought tags from visible content in the same transparent chunk", async () => {
    const { reply, writes } = createReply();
    const upstream = createControlledStream();
    const observedChunks: any[] = [];

    const result = forwardSSEStreamTransparent(
      reply,
      upstream.stream,
      {
        onParsedChunk(data) {
          observedChunks.push(data);
        },
      },
      undefined,
      undefined,
      "openai",
      { modelId: "gemini-2.5-pro", providerProtocol: "openai" },
      googleAdapter,
      { isInsideGoogleThoughtTag: false, isGoogleGemmaStream: false },
      { modelId: "gemini-2.5-pro", providerProtocol: "openai" } as any,
    );

    upstream.enqueueSse({
      id: "chatcmpl-google",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            content: "<thought>private reasoning</thought>visible answer",
          },
          finish_reason: null,
        },
      ],
    });
    await flushMicrotasks();
    upstream.close();
    await result;

    const output = writes.join("");
    expect(output).toContain("\"reasoning_content\":\"private reasoning\"");
    expect(output).toContain("\"content\":\"visible answer\"");
    expect(output).not.toContain("<thought>");
    expect(observedChunks[0].choices[0].delta.reasoning_content).toBe("private reasoning");
    expect(observedChunks[0].choices[0].delta.content).toBe("visible answer");
  });
});

describe("stripNullOpenAIDeltaContent (OpenCode + GLM-5)", () => {
  it("drops content:null so OpenCode does not treat the turn as empty", async () => {
    const { reply, writes } = createReply();
    const upstream = createControlledStream();
    const result = forwardSSEStreamTransparent(
      reply,
      upstream.stream,
      undefined,
      undefined,
      undefined,
      "openai",
    );

    upstream.enqueueSse({
      id: "chatcmpl-glm",
      object: "chat.completion.chunk",
      model: "glm-5",
      choices: [{
        index: 0,
        delta: { content: null, reasoning_content: "让我思考", role: "assistant" },
        finish_reason: null,
      }],
    });
    upstream.enqueueSse({
      id: "chatcmpl-glm",
      object: "chat.completion.chunk",
      model: "glm-5",
      choices: [{
        index: 0,
        delta: { content: "我是GLM。", reasoning_content: null },
        finish_reason: null,
      }],
    });
    upstream.enqueueSse({
      id: "chatcmpl-glm",
      object: "chat.completion.chunk",
      model: "glm-5",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    await flushMicrotasks();
    upstream.close();
    await result;

    const output = writes.join("");
    expect(output).not.toContain('"content":null');
    expect(output).toContain("我是GLM。");
    expect(output).toContain("reasoning_content");
  });
});
