import { describe, expect, it, vi } from "vitest";

/**
 * §9 — Anthropic reasoning + tool-call continuation boundary verification.
 *
 * Validates that when an upstream OpenAI stream contains reasoning_content
 * followed by tool_calls, the Anthropic adapter:
 * 1. Does NOT emit reasoning_content as visible Anthropic content
 * 2. Properly emits tool_use blocks after reasoning
 * 3. Does not leave orphaned text blocks
 */

import { forwardSSEStreamAdapted, type ProtocolAdaptationConfig } from "../src/routes/gateway/streamForwarder";

function createReply() {
  const writes: string[] = [];
  const reply = {
    raw: {
      destroyed: false,
      writableEnded: false,
      __promptgateAnthropicMessageStarted: false,
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

function parseAnthropicEvents(writes: string[]): any[] {
  const events: any[] = [];
  for (const w of writes) {
    const lines = w.split("\n");
    let eventType = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.substring(7).trim();
      }
      if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.substring(6));
          events.push({ event: eventType, data });
        } catch { /* skip non-JSON */ }
      }
    }
  }
  return events;
}

const adaptation: ProtocolAdaptationConfig = {
  targetProtocol: "anthropic",
  messageId: "msg_test_123",
  modelId: "gpt-4o",
  promptTokens: 10,
};

describe("§9 — Anthropic reasoning + tool_call continuation", () => {
  const context = {
    providerId: "test-p",
    providerName: "Test Provider",
    providerProtocol: "openai",
    rawBaseUrl: "https://api.openai.com/v1",
    normalizedBaseUrl: "https://api.openai.com/v1",
    hostname: "api.openai.com",
    pathname: "/v1",
    modelId: "gpt-4o",
    incomingProtocol: "anthropic",
    requestPath: "/v1/chat/completions",
  };

  it("reasoning_content followed by tool_call: reasoning is hidden, tool_use blocks emitted correctly", async () => {
    const { reply, writes } = createReply();
    const upstream = createControlledStream();

    const observerChunks: any[] = [];
    const mockObserver = {
      onParsedChunk(chunk: any) { observerChunks.push(JSON.parse(JSON.stringify(chunk))); },
      onFirstChunk() {},
      onStreamEnd() {},
    };

    const result = forwardSSEStreamAdapted(
      reply,
      upstream.stream,
      adaptation,
      mockObserver,
      { isStitching: false },
      undefined, // streamTimeoutMs
      context,   // TranslatorContext
    );

    // Chunk 1: reasoning_content (should be accumulated, not emitted as text)
    upstream.enqueueLine(`data: ${JSON.stringify({
      choices: [{ delta: { reasoning_content: "Let me think about this..." }, index: 0 }],
    })}`);

    // Chunk 2: more reasoning
    upstream.enqueueLine(`data: ${JSON.stringify({
      choices: [{ delta: { reasoning_content: "I should use a tool." }, index: 0 }],
    })}`);

    // Chunk 3: tool_call start
    upstream.enqueueLine(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_abc", function: { name: "get_weather", arguments: "" } }] }, index: 0 }],
    })}`);

    // Chunk 4: tool_call arguments
    upstream.enqueueLine(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"location":"Tokyo"}' } }] }, index: 0 }],
    })}`);

    // Chunk 5: finish
    upstream.enqueueLine(`data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    })}`);

    upstream.enqueueLine("data: [DONE]");
    upstream.close();

    await result;

    const events = parseAnthropicEvents(writes);

    // Should have message_start
    const messageStarts = events.filter(e => e.data?.type === "message_start");
    expect(messageStarts.length).toBe(1);

    // Reasoning should NOT appear as Anthropic text_delta
    const textDeltas = events.filter(e => e.data?.delta?.type === "text_delta");
    const reasoningInText = textDeltas.some(e =>
      e.data?.delta?.text?.includes("think") || e.data?.delta?.text?.includes("tool")
    );
    expect(reasoningInText).toBe(false);

    // Should NOT have content_block_start with type "text" (no text was emitted)
    const textBlockStarts = events.filter(e =>
      e.data?.type === "content_block_start" && e.data?.content_block?.type === "text"
    );
    expect(textBlockStarts.length).toBe(0);

    // Should have tool_use content_block_start
    const toolUseStarts = events.filter(e =>
      e.data?.type === "content_block_start" && e.data?.content_block?.type === "tool_use"
    );
    expect(toolUseStarts.length).toBe(1);
    expect(toolUseStarts[0].data.content_block.name).toBe("get_weather");

    // Should have input_json_delta
    const inputJsonDeltas = events.filter(e => e.data?.delta?.type === "input_json_delta");
    expect(inputJsonDeltas.length).toBe(1);
    expect(inputJsonDeltas[0].data.delta.partial_json).toBe('{"location":"Tokyo"}');

    // Should have tool_use content_block_stop
    const toolUseStops = events.filter(e => e.data?.type === "content_block_stop");
    expect(toolUseStops.length).toBeGreaterThanOrEqual(1);

    // Observer should have received chunks
    expect(observerChunks.length).toBeGreaterThan(0);
    // Reasoning_content should be available in observer chunks
    const hasReasoningInObserver = observerChunks.some(c =>
      c.choices?.[0]?.delta?.reasoning_content !== undefined
    );
    expect(hasReasoningInObserver).toBe(true);
  });

  it("text content + reasoning_content + tool_call: text is visible, reasoning hidden, tool emitted", async () => {
    const { reply, writes } = createReply();
    const upstream = createControlledStream();

    const mockObserver = {
      onParsedChunk() {},
      onFirstChunk() {},
      onStreamEnd() {},
    };

    const result = forwardSSEStreamAdapted(
      reply,
      upstream.stream,
      adaptation,
      mockObserver,
      { isStitching: false },
      undefined,
      context,
    );

    // Chunk 1: text content
    upstream.enqueueLine(`data: ${JSON.stringify({
      choices: [{ delta: { content: "Here's what I found: " }, index: 0 }],
    })}`);

    // Chunk 2: reasoning
    upstream.enqueueLine(`data: ${JSON.stringify({
      choices: [{ delta: { reasoning_content: "I need to search." }, index: 0 }],
    })}`);

    // Chunk 3: tool_call
    upstream.enqueueLine(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_xyz", function: { name: "search", arguments: '{"q":"test"}' } }] }, index: 0 }],
    })}`);

    // Finish
    upstream.enqueueLine(`data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
    })}`);
    upstream.enqueueLine("data: [DONE]");
    upstream.close();

    await result;

    const events = parseAnthropicEvents(writes);

    // Text content should be visible
    const textDeltas = events.filter(e => e.data?.delta?.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas[0].data.delta.text).toBe("Here's what I found: ");

    // Should have text block properly closed before tool_use
    const textBlockStarts = events.filter(e =>
      e.data?.type === "content_block_start" && e.data?.content_block?.type === "text"
    );
    expect(textBlockStarts.length).toBe(1);

    // Should have tool_use start
    const toolUseStarts = events.filter(e =>
      e.data?.type === "content_block_start" && e.data?.content_block?.type === "tool_use"
    );
    expect(toolUseStarts.length).toBe(1);

    // Text block should be closed (content_block_stop) before tool_use starts
    const blockStopIndices = events.reduce((acc: number[], e, i) => {
      if (e.data?.type === "content_block_stop") acc.push(i);
      return acc;
    }, []);
    const toolStartIndex = events.findIndex(e =>
      e.data?.type === "content_block_start" && e.data?.content_block?.type === "tool_use"
    );

    // At least one block_stop should come before tool_start
    expect(blockStopIndices.some(i => i < toolStartIndex)).toBe(true);
  });
});
