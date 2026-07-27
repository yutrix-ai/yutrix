import { expect, test, describe } from "vitest";
import { createFakeStreamFromData } from "../src/routes/gateway/upstream";

describe("Anthropic fake stream generation", () => {
  test("generates exact Anthropic SSE stream for simple text", async () => {
    const dataObj = {
      id: "msg_01XFD1",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [
        { type: "text", text: "Hello!" }
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 }
    };

    const { fakeStream, textToEmit, isToolCalls } = createFakeStreamFromData(
      dataObj,
      "claude-3-5-sonnet-20241022",
      "anthropic"
    );

    expect(textToEmit).toBe("Hello!");
    expect(isToolCalls).toBe(false);

    const reader = fakeStream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const decoder = new TextDecoder();
    const output = decoder.decode(Buffer.concat(chunks));

    const expectedChunks = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01XFD1","type":"message","role":"assistant","model":"claude-3-5-sonnet-20241022","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello!"}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}`,
      `event: message_stop\ndata: {"type":"message_stop"}`
    ];

    const expectedOutput = expectedChunks.join("\n\n") + "\n\n";

    expect(output).toBe(expectedOutput);
  });

  test("generates exact Anthropic SSE stream for thinking, text, and tools", async () => {
    const dataObj = {
      id: "msg_01XFD2",
      type: "message",
      role: "assistant",
      model: "claude-3-7-sonnet-20250219",
      content: [
        { type: "thinking", thinking: "I need to think...", signature: "sig_123" },
        { type: "text", text: "Here is your answer." },
        { type: "tool_use", id: "call_123", name: "get_weather", input: { location: "London" } }
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 20 }
    };

    const { fakeStream, textToEmit, isToolCalls } = createFakeStreamFromData(
      dataObj,
      "claude-3-7-sonnet-20250219",
      "anthropic"
    );

    expect(textToEmit).toBe("Here is your answer.");
    expect(isToolCalls).toBe(true);

    const reader = fakeStream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const decoder = new TextDecoder();
    const output = decoder.decode(Buffer.concat(chunks));

    const expectedChunks = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01XFD2","type":"message","role":"assistant","model":"claude-3-7-sonnet-20250219","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"I need to think..."}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_123"}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Here is your answer."}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_123","name":"get_weather","input":{}}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"location\\":\\"London\\"}"}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":2}`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":20}}`,
      `event: message_stop\ndata: {"type":"message_stop"}`
    ];

    const expectedOutput = expectedChunks.join("\n\n") + "\n\n";

    expect(output).toBe(expectedOutput);
  });

  describe("Round-trip: blocks to fake SSE to rebuilt blocks", () => {
    async function getRebuiltBlocks(dataObj: any, modelId: string): Promise<any[]> {
      const { fakeStream } = createFakeStreamFromData(dataObj, modelId, "anthropic");
      const reader = fakeStream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const text = new TextDecoder().decode(Buffer.concat(chunks));
      const events = text.split("\n\n").filter(Boolean);

      const rebuiltContent: any[] = [];
      let currentBlock: any = null;

      for (const event of events) {
        const lines = event.split("\n");
        const dataLine = lines.find(l => l.startsWith("data: "));
        if (!dataLine) continue;
        const data = JSON.parse(dataLine.replace("data: ", ""));

        if (data.type === "content_block_start") {
          currentBlock = { ...data.content_block };
          if (currentBlock.type === "thinking") {
            currentBlock.thinking = "";
          }
          rebuiltContent.push(currentBlock);
        } else if (data.type === "content_block_delta") {
          if (data.delta.type === "thinking_delta") {
            currentBlock.thinking += data.delta.thinking;
          } else if (data.delta.type === "signature_delta") {
            currentBlock.signature = data.delta.signature;
          } else if (data.delta.type === "text_delta") {
            currentBlock.text = (currentBlock.text || "") + data.delta.text;
          } else if (data.delta.type === "input_json_delta") {
            currentBlock.input = JSON.parse(data.delta.partial_json);
          }
        }
      }
      return rebuiltContent;
    }

    test("thinking + signature", async () => {
      const originalBlocks = [
        { type: "thinking", thinking: "Deep thought...", signature: "sig_456" }
      ];
      const dataObj = { content: originalBlocks, id: "msg_123", usage: { input_tokens: 5, output_tokens: 5 } };
      const rebuilt = await getRebuiltBlocks(dataObj, "claude-3-7");
      expect(rebuilt).toStrictEqual(originalBlocks);
    });

    test("redacted_thinking", async () => {
      const originalBlocks = [
        { type: "redacted_thinking", data: "encrypted_payload_verbatim_123" }
      ];
      const dataObj = { content: originalBlocks, id: "msg_123", usage: { input_tokens: 5, output_tokens: 5 } };
      const rebuilt = await getRebuiltBlocks(dataObj, "claude-3-7");
      expect(rebuilt).toStrictEqual(originalBlocks);
    });

    test("thinking + text + tool_use", async () => {
      const originalBlocks = [
        { type: "thinking", thinking: "Let me check the weather first.", signature: "sig_abc" },
        { type: "text", text: "I'll fetch the weather now." },
        { type: "tool_use", id: "t_1", name: "get_weather", input: { city: "Paris" } }
      ];
      const dataObj = { content: originalBlocks, id: "msg_123", usage: { input_tokens: 5, output_tokens: 5 } };
      const rebuilt = await getRebuiltBlocks(dataObj, "claude-3-7");
      expect(rebuilt).toStrictEqual(originalBlocks);
    });

    test("redacted_thinking + tool_use", async () => {
      const originalBlocks = [
        { type: "redacted_thinking", data: "some_redacted_data" },
        { type: "tool_use", id: "t_2", name: "some_tool", input: { arg: 42 } }
      ];
      const dataObj = { content: originalBlocks, id: "msg_123", usage: { input_tokens: 5, output_tokens: 5 } };
      const rebuilt = await getRebuiltBlocks(dataObj, "claude-3-7");
      expect(rebuilt).toStrictEqual(originalBlocks);
    });

    test("multiple blocks interleaved", async () => {
      const originalBlocks = [
        { type: "thinking", thinking: "think 1", signature: "sig1" },
        { type: "text", text: "text 1" },
        { type: "thinking", thinking: "think 2", signature: "sig2" },
        { type: "text", text: "text 2" }
      ];
      const dataObj = { content: originalBlocks, id: "msg_123", usage: { input_tokens: 5, output_tokens: 5 } };
      const rebuilt = await getRebuiltBlocks(dataObj, "claude-3-7");
      expect(rebuilt).toStrictEqual(originalBlocks);
    });
  });
});
