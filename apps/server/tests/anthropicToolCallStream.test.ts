import { describe, expect, test, vi } from 'vitest';
import { forwardSSEStreamAdapted } from '../src/routes/gateway/streamForwarder';
import { ReadableStream } from 'stream/web';

describe('Anthropic Native Tool Calling from OpenAI Stream', () => {
  test('Strict Anthropic event sequence for tool calls', async () => {
    const chunks = [
      // 1. Text and tool call start in the SAME chunk (OpenAI can do this sometimes, or closely in sequence)
      { choices: [{ delta: { content: "I need to search.", tool_calls: [{ index: 0, id: "call_1", function: { name: "search" } }] }, finish_reason: null }] },
      // 2. Tool call arguments 1
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"" } }] }, finish_reason: null }] },
      // 3. Finish
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
    ];

    const encoder = new TextEncoder();
    let chunkIndex = 0;
    const readerMock = {
      read: vi.fn().mockImplementation(async () => {
        if (chunkIndex < chunks.length) {
          const chunk = chunks[chunkIndex++];
          return { done: false, value: encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`) };
        } else if (chunkIndex === chunks.length) {
          chunkIndex++;
          return { done: false, value: encoder.encode(`data: [DONE]\n\n`) };
        }
        return { done: true, value: undefined };
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const stream = {
      getReader: () => readerMock
    };

    const writes: string[] = [];
    const reply: any = {
      raw: {
        write: vi.fn().mockImplementation((str) => { writes.push(str); return true; }),
        end: vi.fn(),
      }
    };

    const ctx = {
      request: { headers: {} },
      reply,
      baseActionLog: {},
      currentAttempt: { modelId: "test-model" },
    };

    await forwardSSEStreamAdapted(
      reply,
      stream as any,
      { modelId: "test-model", isFallback: false, fallbackReason: "", providerProtocol: "openai", promptTokens: 0, completionTokens: 0 } as any, // adaptation
      undefined, // observer
      undefined, // stitchState
      5000,      // streamTimeoutMs
    );

    const fullOutput = writes.join("");

    // Check strict sequence
    expect(fullOutput).toContain('event: message_start');

    // First, a text block starts
    expect(fullOutput).toContain('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}');
    expect(fullOutput).toContain('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I need to search."}}');

    // Then it must be closed BEFORE the tool_use block starts
    const stopTextIndex = fullOutput.indexOf('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}');
    const startToolIndex = fullOutput.indexOf('event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"search","input":{}}}');

    expect(stopTextIndex).toBeGreaterThan(-1);
    expect(startToolIndex).toBeGreaterThan(stopTextIndex);

    // Then tool args
    const arg1Index = fullOutput.indexOf('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\""}}');

    expect(arg1Index).toBeGreaterThan(startToolIndex);

    // Then tool must be closed
    const stopToolIndex = fullOutput.indexOf('event: content_block_stop\ndata: {"type":"content_block_stop","index":1}');
    expect(stopToolIndex).toBeGreaterThan(arg1Index);

    // Finally, message_delta and message_stop
    const messageDeltaIndex = fullOutput.indexOf('event: message_delta');
    expect(messageDeltaIndex).toBeGreaterThan(stopToolIndex);

    // Check stop_reason
    expect(fullOutput.slice(messageDeltaIndex)).toContain('"stop_reason":"tool_use"');
  });
});
