import { describe, expect, it } from "vitest";
import { applyInputTokenLimit } from "../src/routes/gateway/inputTokenLimit";
import { exactEstimateTokens } from "../src/utils/tokenizer";

const baseConfig = {
  modelId: "gpt-4o",
  providerProtocol: "openai",
  maxInputTokens: 250,
};

describe("input token truncation", () => {
  it("does not modify requests under the effective limit", async () => {
    const body = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
      ],
    };

    const result = await applyInputTokenLimit(body, {
      ...baseConfig,
      maxInputTokens: 1000,
    });

    expect(result.truncated).toBe(false);
    expect(body.messages).toHaveLength(2);
  });

  it("drops old turns while preserving the latest OpenAI tool-call chain", async () => {
    const body = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Keep tool messages valid." },
        { role: "user", content: "old ".repeat(2000) },
        { role: "assistant", content: "Old answer." },
        { role: "user", content: "What is the weather?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_weather",
              type: "function",
              function: { name: "weather", arguments: "{\"city\":\"Shanghai\"}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_weather", content: "Sunny, 28C" },
        { role: "assistant", content: "It is sunny." },
      ],
    };

    const result = await applyInputTokenLimit(body, baseConfig);

    expect(result.truncated).toBe(true);
    expect(result.droppedTurns).toBeGreaterThan(0);
    expect(body.messages.some((message: any) => String(message.content).includes("old old"))).toBe(false);
    expect(body.messages.some((message: any) => message.tool_calls?.[0]?.id === "call_weather")).toBe(true);
    expect(body.messages.some((message: any) => message.role === "tool" && message.tool_call_id === "call_weather")).toBe(true);
  });

  it("safely truncates a too-large latest user message with head and tail retained", async () => {
    const body = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Answer from the supplied log." },
        {
          role: "user",
          content: `开头🙂${"日志行 ".repeat(2500)}结尾✅`,
        },
      ],
    };

    const result = await applyInputTokenLimit(body, {
      ...baseConfig,
      maxInputTokens: 180,
    });
    const content = body.messages[1].content;

    expect(result.truncated).toBe(true);
    expect(result.textTruncated).toBe(true);
    expect(content).toContain("PromptGate: content truncated");
    expect(content).toContain("开头");
    expect(content).toContain("结尾");
    expect(content).not.toContain("\uFFFD");
  });

  it("keeps Anthropic tool_use and tool_result messages in the same surviving turn", async () => {
    const body = {
      model: "claude-sonnet-4-5",
      system: "Use tools carefully.",
      messages: [
        { role: "user", content: "old ".repeat(2000) },
        { role: "assistant", content: "Old answer." },
        { role: "user", content: "Look up this value." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "lookup",
              input: { key: "abc" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "lookup result",
            },
          ],
        },
        { role: "assistant", content: "The value is lookup result." },
      ],
    };

    const result = await applyInputTokenLimit(body, {
      modelId: "claude-sonnet-4-5",
      providerProtocol: "anthropic",
      maxInputTokens: 180,
    });

    expect(result.truncated).toBe(true);
    expect(JSON.stringify(body.messages)).toContain("toolu_1");
    expect(JSON.stringify(body.messages)).toContain("tool_result");
    expect(JSON.stringify(body.messages)).not.toContain("old old");
  });
});

describe("OpenAI tokenizer path", () => {
  it("counts modern OpenAI models without relying on the old native o200k support", async () => {
    const count = await exactEstimateTokens("hello 中文", "gpt-4o");
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10);
  });
});
