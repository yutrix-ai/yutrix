import { describe, expect, it, vi } from "vitest";
import { openRouterAdapter } from "../src/routes/gateway/providerAdapters/openRouterAdapter";
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

describe("observation audit wiring — reasoning data reaches observer", () => {
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

  it("reasoning_details text is available in observation but original SSE stays byte-identical", async () => {
    const state = openRouterAdapter.createAttemptState!(context);
    const { reply, writes } = createReply();
    const upstream = createControlledStream();

    const detailsData = [{ type: "text", text: "deep thought" }];
    const chunkJson = JSON.stringify({
      choices: [{ delta: { reasoning_details: detailsData } }]
    });
    const rawLine = `data: ${chunkJson}`;

    // Capture observer onParsedChunk calls
    const observerChunks: any[] = [];
    const mockObserver = {
      onParsedChunk(chunk: any) { observerChunks.push(JSON.parse(JSON.stringify(chunk))); },
      onFirstChunk() {},
    };

    const result = forwardSSEStreamTransparent(
      reply, upstream.stream,
      mockObserver, undefined, undefined,
      "openai", undefined,
      openRouterAdapter, state, context
    );

    upstream.enqueueLine(rawLine);
    await flushMicrotasks();
    upstream.close();
    await result;

    // The original SSE line must be forwarded byte-identical
    expect(writes.join("")).toContain(chunkJson);
    // The observation should have marked meaningful
    expect(state.hadMeaningfulAdapterEvent).toBe(true);
  });

  it("reasoning text with signature extracts text, not signature", () => {
    const details = [
      { type: "text", text: "visible thought", signature: "sig_abc123" },
      { type: "summary", summary: "a summary" },
      { type: "encrypted", data: "encrypted_data_xyz" },
    ];

    const chunk = {
      choices: [{ delta: { reasoning_details: details } }]
    };
    const state = openRouterAdapter.createAttemptState!(context);
    const observation = openRouterAdapter.observeStreamChunk!(
      JSON.parse(JSON.stringify(chunk)), state, context
    );

    // Should extract text from "text" item (even though it has signature)
    expect(observation?.reasoningText).toContain("visible thought");
    // Should extract summary
    expect(observation?.reasoningText).toContain("a summary");
    // Should NOT contain encrypted data
    expect(observation?.reasoningText).not.toContain("encrypted_data_xyz");
    // Should NOT contain signature
    expect(observation?.reasoningText).not.toContain("sig_abc123");
  });

  it("reasoning_content is not double-counted when both reasoning_content and reasoning exist", () => {
    const chunk = {
      choices: [{
        delta: {
          reasoning_content: "standard reasoning",
          reasoning: "extra reasoning"
        }
      }]
    };
    const state = openRouterAdapter.createAttemptState!(context);
    const observation = openRouterAdapter.observeStreamChunk!(
      JSON.parse(JSON.stringify(chunk)), state, context
    );

    // The observation's reasoningText includes both
    expect(observation?.reasoningText).toContain("standard reasoning");
    expect(observation?.reasoningText).toContain("extra reasoning");
    expect(observation?.meaningful).toBe(true);
  });

  it("reasoning_details-only (no reasoning_content) enters observation", () => {
    const chunk = {
      choices: [{
        delta: {
          reasoning_details: [{ type: "text", text: "details only" }]
        }
      }]
    };
    const state = openRouterAdapter.createAttemptState!(context);
    const observation = openRouterAdapter.observeStreamChunk!(
      JSON.parse(JSON.stringify(chunk)), state, context
    );

    expect(observation?.reasoningText).toBe("details only");
    expect(observation?.meaningful).toBe(true);
  });

  it("reasoning + reasoning_details order is stable", () => {
    const chunk = {
      choices: [{
        delta: {
          reasoning_content: "A",
          reasoning: "B",
          reasoning_details: [{ type: "text", text: "C" }]
        }
      }]
    };
    const state = openRouterAdapter.createAttemptState!(context);
    const observation = openRouterAdapter.observeStreamChunk!(
      JSON.parse(JSON.stringify(chunk)), state, context
    );

    // Should concatenate in order: reasoning_content, reasoning, reasoning_details
    expect(observation?.reasoningText).toBe("ABC");
  });

  it("encrypted reasoning detail does not leak data", () => {
    const chunk = {
      choices: [{
        delta: {
          reasoning_details: [
            { type: "encrypted", data: "super_secret_encrypted_payload" }
          ]
        }
      }]
    };
    const state = openRouterAdapter.createAttemptState!(context);
    const observation = openRouterAdapter.observeStreamChunk!(
      JSON.parse(JSON.stringify(chunk)), state, context
    );

    // Should not contain the encrypted data
    if (observation?.reasoningText) {
      expect(observation.reasoningText).not.toContain("super_secret_encrypted_payload");
    }
    // But should still be meaningful (has reasoning_details)
    expect(observation?.meaningful).toBe(true);
  });
});
