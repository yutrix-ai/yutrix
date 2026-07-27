import { describe, expect, it, vi } from "vitest";
import { googleAdapter } from "../src/routes/gateway/providerAdapters/googleAdapter";
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

describe("googleAdapter regression and double-execution protection", () => {
  const context = {
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

  it("googleAdapter matches url correctly", () => {
    expect(googleAdapter.match(context)).toBe(true);

    // Non-Google context
    const nonGoogleCtx = {
      ...context,
      providerName: "OpenAI",
      hostname: "api.openai.com",
      providerProtocol: "openai",
      modelId: "gpt-4o"
    };
    expect(googleAdapter.match(nonGoogleCtx)).toBe(false);
  });

  it("handles single-chunk and cross-chunk Google thought tags correctly", async () => {
    const { reply, writes } = createReply();
    const upstream = createControlledStream();
    const state = googleAdapter.createAttemptState!(context);

    const result = forwardSSEStreamTransparent(
      reply,
      upstream.stream,
      undefined,
      undefined,
      undefined,
      "openai",
      undefined,
      googleAdapter,
      state,
      context
    );

    // Chunk 1: thought starts
    upstream.enqueueLine('data: {"choices":[{"delta":{"content":"<thought>thinking part 1"}}]}');
    await flushMicrotasks();
    // Chunk 2: thought ends
    upstream.enqueueLine('data: {"choices":[{"delta":{"content":" part 2</thought>visible content"}}]}');
    await flushMicrotasks();
    upstream.close();
    await result;

    const output = writes.join("");
    expect(output).toContain('"reasoning_content":"thinking part 1"');
    expect(output).toContain('"reasoning_content":" part 2"');
    expect(output).toContain('"content":"visible content"');
    // Ensure tags are stripped
    expect(output).not.toContain("<thought>");
    expect(output).not.toContain("</thought>");
  });

  it("verifies non-Google models are not converted", async () => {
    const { reply, writes } = createReply();
    const upstream = createControlledStream();

    const result = forwardSSEStreamTransparent(
      reply,
      upstream.stream,
      undefined,
      undefined,
      undefined,
      "openai",
      undefined,
      undefined, // No adapter resolved -> fallback transparent
      undefined,
      undefined
    );

    upstream.enqueueLine('data: {"choices":[{"delta":{"content":"<thought>not gemini</thought>"}}]}');
    await flushMicrotasks();
    upstream.close();
    await result;

    const output = writes.join("");
    expect(output).toContain("<thought>not gemini</thought>");
    expect(output).not.toContain("reasoning_content");
  });

  it("ensures thought translation is not executed twice", async () => {
    // googleAdapter wraps googleGemmaTranslator and translates delta.
    // If it were executed twice, reasoning_content would duplicate or content would be missing.
    const chunk = {
      choices: [
        {
          delta: {
            content: "<thought>once</thought>hello",
          }
        }
      ]
    };
    const state = googleAdapter.createAttemptState!(context);

    // First translation
    const modified = googleAdapter.transformStreamChunk!(chunk, state, context);
    expect(modified).toBe(true);
    expect(chunk.choices[0].delta.reasoning_content).toBe("once");
    expect(chunk.choices[0].delta.content).toBe("hello");

    // Second execution on the same chunk
    const secondModified = googleAdapter.transformStreamChunk!(chunk, state, context);
    // Should return false and not touch/duplicate because isGoogleThoughtPayload is false on delta without content "<thought>"
    expect(secondModified).toBe(false);
    expect(chunk.choices[0].delta.reasoning_content).toBe("once");
    expect(chunk.choices[0].delta.content).toBe("hello");
  });

  it("handles non-stream Google thought translation correctly", () => {
    const response = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "<thought>private thought</thought>visible content"
          }
        }
      ]
    };

    const modified = googleAdapter.transformNonStreamResponse!(response, context);
    expect(modified).toBe(true);
    expect((response.choices[0].message as any).reasoning_content).toBe("private thought");
    expect(response.choices[0].message.content).toBe("visible content");
  });
});
