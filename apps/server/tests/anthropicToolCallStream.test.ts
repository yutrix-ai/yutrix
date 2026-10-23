import { describe, expect, test, vi } from 'vitest';
import { forwardSSEStreamAdapted } from '../src/routes/gateway/streamForwarder';
import { adaptRequestProtocol } from '../src/routes/gateway/protocolAdapter';
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

  test('Interleaved text after tool_calls and reused index=0 tool calls never send text_delta to a tool_use block', async () => {
    const chunks = [
      { choices: [{ delta: { content: "我将直接查看文档中解包出来的 7 张图片。" }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_img_1", function: { name: "Read", arguments: '{"file_path":"image1.png"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: { content: "\n" }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_img_2", function: { name: "Read", arguments: '{"file_path":"image2.png"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
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

    const writes: string[] = [];
    const reply: any = {
      raw: {
        write: vi.fn().mockImplementation((str) => { writes.push(str); return true; }),
        end: vi.fn(),
      }
    };

    await forwardSSEStreamAdapted(
      reply,
      { getReader: () => readerMock } as any,
      { modelId: "gemini-4-argon-high", targetProtocol: "anthropic", messageId: "msg_1", promptTokens: 10 } as any,
      undefined,
      undefined,
      5000,
    );

    // Simulate @anthropic-ai/sdk MessageStream block accumulator
    const blocks: Record<number, { type: string; closed: boolean }> = {};
    for (const raw of writes.join("").split("\n\n")) {
      const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const evt = JSON.parse(dataLine.slice(6));
      if (evt.type === "content_block_start") {
        expect(blocks[evt.index]).toBeUndefined();
        blocks[evt.index] = { type: evt.content_block.type, closed: false };
      } else if (evt.type === "content_block_delta") {
        const block = blocks[evt.index];
        expect(block).toBeDefined();
        expect(block.closed).toBe(false);
        if (evt.delta.type === "text_delta") {
          expect(block.type).toBe("text");
        } else if (evt.delta.type === "input_json_delta") {
          expect(block.type).toBe("tool_use");
        }
      } else if (evt.type === "content_block_stop") {
        const block = blocks[evt.index];
        expect(block).toBeDefined();
        expect(block.closed).toBe(false);
        block.closed = true;
      }
    }

    expect(Object.keys(blocks).map(Number)).toEqual([0, 1, 2, 3]);
    expect(Object.values(blocks).every((b) => b.closed)).toBe(true);
  });

  test('Anthropic tool_result containing base64 images preserves images when adapted to OpenAI', () => {
    const body = {
      model: "gemini-4-argon-high",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading images" },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "image1.png" } },
            { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "image2.png" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "aW1nMQ==" },
                },
              ],
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              content: [
                { type: "text", text: "Image 2 caption" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "aW1nMg==" },
                },
              ],
            },
          ],
        },
      ],
    };

    const { finalBody } = adaptRequestProtocol(body, "anthropic", false, true, "gemini-4-argon-high", {}, () => {});
    expect(finalBody.messages).toHaveLength(4);
    expect(finalBody.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "toolu_1",
      content: "[Image content attached in following user message]",
    });
    expect(finalBody.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "toolu_2",
      content: "Image 2 caption",
    });
    expect(finalBody.messages[3]).toEqual({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1nMQ==" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1nMg==" } },
      ],
    });
  });
});
