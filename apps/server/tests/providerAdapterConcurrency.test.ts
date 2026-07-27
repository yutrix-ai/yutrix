import { describe, expect, it, vi } from "vitest";
import { openRouterAdapter } from "../src/routes/gateway/providerAdapters/openRouterAdapter";
import { googleAdapter } from "../src/routes/gateway/providerAdapters/googleAdapter";
import { transparentAdapter } from "../src/routes/gateway/providerAdapters/transparentAdapter";
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
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();

  return {
    stream,
    enqueueLine(line: string) {
      controller.enqueue(encoder.encode(line + "\n"));
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

describe("concurrency, isolation, and fault boundaries", () => {
  it("runs different adapter flows concurrently and ensures perfect state isolation", async () => {
    // Context A: OpenRouter reasoning_details
    const contextA = {
      providerId: "or-p",
      providerName: "OpenRouter",
      providerProtocol: "openai",
      rawBaseUrl: "https://openrouter.ai/api/v1",
      normalizedBaseUrl: "https://openrouter.ai/api/v1",
      hostname: "openrouter.ai",
      pathname: "/api/v1",
      modelId: "llama3",
      incomingProtocol: "openai",
      requestPath: "/v1/chat/completions"
    };
    const stateA = openRouterAdapter.createAttemptState!(contextA);

    // Context B: OpenRouter standard content (no reasoning)
    const contextB = {
      ...contextA,
      modelId: "mistral"
    };
    const stateB = openRouterAdapter.createAttemptState!(contextB);

    // Context C: Google thought stream
    const contextC = {
      providerId: "google-p",
      providerName: "Google Provider",
      providerProtocol: "google",
      rawBaseUrl: "https://generativelanguage.googleapis.com",
      normalizedBaseUrl: "https://generativelanguage.googleapis.com",
      hostname: "generativelanguage.googleapis.com",
      pathname: "",
      modelId: "gemini-2.5-flash",
      incomingProtocol: "openai",
      requestPath: "/v1/chat/completions"
    };
    const stateC = googleAdapter.createAttemptState!(contextC);

    // Context D: Transparent stream
    const contextD = {
      providerId: "openai-p",
      providerName: "OpenAI compatible provider",
      providerProtocol: "openai",
      rawBaseUrl: "https://api.someprovider.com/v1",
      normalizedBaseUrl: "https://api.someprovider.com/v1",
      hostname: "api.someprovider.com",
      pathname: "/v1",
      modelId: "gpt-4o",
      incomingProtocol: "openai",
      requestPath: "/v1/chat/completions"
    };
    const stateD = transparentAdapter.createAttemptState!(contextD);

    // Create stream objects for concurrent forwarding
    const streamA = createControlledStream();
    const replyA = createReply();

    const streamB = createControlledStream();
    const replyB = createReply();

    const streamC = createControlledStream();
    const replyC = createReply();

    const streamD = createControlledStream();
    const replyD = createReply();

    // Start all forwardings in parallel
    const pA = forwardSSEStreamTransparent(replyA.reply, streamA.stream, undefined, undefined, undefined, "openai", undefined, openRouterAdapter, stateA, contextA);
    const pB = forwardSSEStreamTransparent(replyB.reply, streamB.stream, undefined, undefined, undefined, "openai", undefined, openRouterAdapter, stateB, contextB);
    const pC = forwardSSEStreamTransparent(replyC.reply, streamC.stream, undefined, undefined, undefined, "openai", undefined, googleAdapter, stateC, contextC);
    const pD = forwardSSEStreamTransparent(replyD.reply, streamD.stream, undefined, undefined, undefined, "openai", undefined, transparentAdapter, stateD, contextD);

    // Enqueue chunks concurrently
    streamA.enqueueLine('data: {"choices":[{"delta":{"reasoning_details":[{"type":"text","text":"thought A"}]}}]}');
    streamB.enqueueLine('data: {"choices":[{"delta":{"content":"content B"}}]}');
    streamC.enqueueLine('data: {"choices":[{"delta":{"content":"<thought>thinking C</thought>"}}]}');
    streamD.enqueueLine('data: {"choices":[{"delta":{"content":"normal content D"}}]}');

    await flushMicrotasks();

    streamA.close();
    streamB.close();
    streamC.close();
    streamD.close();

    await Promise.all([pA, pB, pC, pD]);

    // Assertions:
    // 1. A's reasoning details did not enter B's output
    expect(replyA.writes.join("")).toContain('"reasoning_details"');
    expect(replyB.writes.join("")).not.toContain('"reasoning_details"');
    expect(replyB.writes.join("")).toContain("content B");

    // 2. Google thought state C did not affect OpenRouter A or B
    expect(stateC.isGoogleGemmaStream).toBe(true);
    expect(stateA.isGoogleGemmaStream).toBeUndefined();
    expect(stateB.isGoogleGemmaStream).toBeUndefined();

    // 3. A had meaningful event, D and B did not
    expect(stateA.hadMeaningfulAdapterEvent).toBe(true);
    expect(stateB.hadMeaningfulAdapterEvent).toBe(false);

    // 4. Terminal error states are completely isolated
    expect(stateA.terminalError).toBeNull();
    expect(stateB.terminalError).toBeNull();
    expect(stateC.terminalError).toBeUndefined();
  });

  it("handles observer exceptions gracefully without interrupting the stream", async () => {
    const context = {
      providerId: "or-p",
      providerName: "OpenRouter",
      providerProtocol: "openai",
      rawBaseUrl: "https://openrouter.ai/api/v1",
      normalizedBaseUrl: "https://openrouter.ai/api/v1",
      hostname: "openrouter.ai",
      pathname: "/api/v1",
      modelId: "llama3",
      incomingProtocol: "openai",
      requestPath: "/v1/chat/completions"
    };

    const faultyAdapter = {
      ...openRouterAdapter,
      observeStreamChunk() {
        throw new Error("Observer crash test");
      }
    };

    const state = faultyAdapter.createAttemptState(context);
    const { reply, writes } = createReply();
    const stream = createControlledStream();

    const logAction = vi.fn();
    const baseActionLog = { requestId: "req-1" };

    const result = forwardSSEStreamTransparent(
      reply,
      stream.stream,
      undefined,
      undefined,
      undefined,
      "openai",
      undefined,
      faultyAdapter,
      state,
      context,
      logAction,
      baseActionLog
    );

    stream.enqueueLine('data: {"choices":[{"delta":{"content":"normal content"}}]}');
    await flushMicrotasks();
    stream.close();
    await result;

    // Stream still forwards normally despite observer exception
    expect(writes.join("")).toContain("normal content");
    // logAction is notified about the observer error
    expect(logAction).toHaveBeenCalled();
    const firstCallArgs = logAction.mock.calls[0][0];
    expect(firstCallArgs.code).toBe("request.provider_adapter.observer_error");
    expect(firstCallArgs.message).toContain("Observer crash test");
  });
});
