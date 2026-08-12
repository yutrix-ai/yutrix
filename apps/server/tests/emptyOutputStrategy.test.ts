import { describe, expect, it } from "vitest";
import { EmptyOutputStrategy } from "../src/services/continuity/strategies/EmptyOutputStrategy";
import { ContinuityContext } from "../src/services/continuity/types";

describe("EmptyOutputStrategy Unit Tests", () => {
  const strategy = new EmptyOutputStrategy();

  it("has correct strategy name and default maxRetries", () => {
    expect(strategy.name).toBe("EmptyOutput");
    expect(strategy.maxRetries).toBe(2);
  });

  it("should intervene when response is 200 with empty content and no tool calls", async () => {
    const context: ContinuityContext = {
      originalBody: {
        model: "gemini-3.6-flash",
        messages: [{ role: "user", content: "hello" }],
      },
      responseData: {
        status: 200,
        data: {
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
        },
      },
      accumulatedCompletionText: "",
      baseActionLog: {},
      currentAttempt: { modelId: "gemini-3.6-flash" },
      state: new Map(),
    };

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.strategyName).toBe("EmptyOutput");
    expect(decision.modifiedBody).toBeDefined();

    // Verify injected message in modified body
    const messages = decision.modifiedBody.messages;
    expect(messages.length).toBe(2);
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("System Guard Note");
  });

  it("should NOT intervene when content is non-empty", async () => {
    const context: ContinuityContext = {
      originalBody: {
        messages: [{ role: "user", content: "hello" }],
      },
      responseData: {
        status: 200,
        data: {
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello world" },
              finish_reason: "stop",
            },
          ],
        },
      },
      accumulatedCompletionText: "Hello world",
      baseActionLog: {},
      currentAttempt: { modelId: "gemini-3.6-flash" },
      state: new Map(),
    };

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(false);
  });

  it("should NOT intervene when tool_calls are present", async () => {
    const context: ContinuityContext = {
      originalBody: {
        messages: [{ role: "user", content: "do action" }],
      },
      responseData: {
        status: 200,
        data: {
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "call_123", type: "function", function: { name: "test_tool" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      },
      accumulatedCompletionText: "",
      baseActionLog: {},
      currentAttempt: { modelId: "gemini-3.6-flash" },
      state: new Map(),
    };

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(false);
  });

  it("should NOT intervene when reasoning_content is present", async () => {
    const context: ContinuityContext = {
      originalBody: {
        messages: [{ role: "user", content: "think" }],
      },
      responseData: {
        status: 200,
        data: {
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                reasoning_content: "thinking steps...",
              },
              finish_reason: "stop",
            },
          ],
        },
      },
      accumulatedCompletionText: "<think>thinking steps...</think>",
      baseActionLog: {},
      currentAttempt: { modelId: "gemini-3.6-flash" },
      state: new Map(),
    };

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(false);
  });

  it("should inject fallback message when onExhausted is called", async () => {
    const context: ContinuityContext = {
      originalBody: {
        messages: [{ role: "user", content: "hello" }],
      },
      responseData: {
        status: 200,
        data: {
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "" },
              finish_reason: "stop",
            },
          ],
        },
      },
      accumulatedCompletionText: "",
      baseActionLog: {},
      currentAttempt: { modelId: "gemini-3.6-flash" },
      state: new Map(),
    };

    const modifiedResponse = await strategy.onExhausted(context);
    expect(modifiedResponse.data.choices[0].message.content).toContain("模型响应结果为空");
  });
});
