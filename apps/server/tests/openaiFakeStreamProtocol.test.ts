import { describe, expect, it } from "vitest";
import { coerceToOpenAICompletionShape, createFakeStreamFromData } from "../src/routes/gateway/upstream";

async function readStreamText(stream: ReadableStream): Promise<string> {
  return await new Response(stream).text();
}

describe("OpenAI fake-stream protocol (regression: type=message must not blank OpenCode)", () => {
  it("emits OpenAI SSE when payload has type=message AND choices (Antigravity-style)", async () => {
    const data = {
      type: "message",
      id: "chatcmpl-ag",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "你好，我是数字员工助手。" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 539, completion_tokens: 2, total_tokens: 541 },
    };

    const { fakeStream, textToEmit } = createFakeStreamFromData(data, "gemini-3.6-flash-tiered", "openai");
    expect(textToEmit).toBe("你好，我是数字员工助手。");

    const sse = await readStreamText(fakeStream);
    expect(sse).not.toMatch(/event:\s*message_start/);
    expect(sse).toContain("你好，我是数字员工助手。");
    expect(sse).toContain("chat.completion.chunk");
    expect(sse).toContain("[DONE]");
  });

  it("coerces Anthropic-shaped JSON (no choices) into OpenAI completion before fake stream", async () => {
    const anthropicShaped = {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "你好，我是助手。" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
    };

    const coerced = coerceToOpenAICompletionShape(anthropicShaped, "gemini-3.6-flash-tiered");
    expect(coerced.choices[0].message.content).toBe("你好，我是助手。");

    const { fakeStream, textToEmit } = createFakeStreamFromData(
      coerced,
      "gemini-3.6-flash-tiered",
      "openai",
    );
    expect(textToEmit).toBe("你好，我是助手。");
    const sse = await readStreamText(fakeStream);
    expect(sse).not.toMatch(/event:\s*message_start/);
    expect(sse).toContain("你好，我是助手。");
  });
});
