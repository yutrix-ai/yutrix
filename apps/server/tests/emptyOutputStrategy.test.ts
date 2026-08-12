import { describe, expect, it } from "vitest";
import { EmptyOutputStrategy } from "../src/services/continuity/strategies/EmptyOutputStrategy";
import { MaxTokensTruncationStrategy } from "../src/services/continuity/strategies/MaxTokensTruncationStrategy";
import { ReasoningExhaustionStrategy } from "../src/services/continuity/strategies/ReasoningExhaustionStrategy";
import { ContinuityContext } from "../src/services/continuity/types";

function baseContext(overrides: Partial<ContinuityContext> & { responseData: any }): ContinuityContext {
  return {
    originalBody: {
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "hello" }],
    },
    accumulatedCompletionText: "",
    baseActionLog: {},
    currentAttempt: { modelId: "gemini-3.6-flash" },
    state: new Map(),
    ...overrides,
  };
}

describe("EmptyOutputStrategy Unit Tests", () => {
  const strategy = new EmptyOutputStrategy();

  it("has correct strategy name and default maxRetries", () => {
    expect(strategy.name).toBe("EmptyOutput");
    expect(strategy.maxRetries).toBe(2);
  });

  it("should intervene when response is 200 with empty content and no tool calls", async () => {
    const context = baseContext({
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
    });

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

  it("should intervene for Anthropic-style empty content array", async () => {
    const context = baseContext({
      responseData: {
        status: 200,
        data: {
          type: "message",
          role: "assistant",
          content: [],
          stop_reason: "end_turn",
        },
      },
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.strategyName).toBe("EmptyOutput");
  });

  it("should NOT intervene when content is non-empty", async () => {
    const context = baseContext({
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
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(false);
  });

  it("should NOT intervene when tool_calls are present", async () => {
    const context = baseContext({
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
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(false);
  });

  it("should NOT intervene when Anthropic tool_use blocks are present", async () => {
    const context = baseContext({
      responseData: {
        status: 200,
        data: {
          type: "message",
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "search", input: { q: "x" } }],
          stop_reason: "tool_use",
        },
      },
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(false);
  });

  it("should NOT intervene when Anthropic thinking blocks are present", async () => {
    const context = baseContext({
      responseData: {
        status: 200,
        data: {
          type: "message",
          role: "assistant",
          content: [{ type: "thinking", thinking: "internal chain of thought" }],
          stop_reason: "end_turn",
        },
      },
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(false);
  });

  it("should NOT intervene when reasoning_content is present", async () => {
    const context = baseContext({
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
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(false);
  });

  it("should NOT intervene mid-stream before streamResult is available (live stream)", async () => {
    const context = baseContext({
      responseData: {
        status: 200,
        isStream: true,
        // not a fake stream — live SSE still flowing
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
      // streamResult intentionally omitted — stream still flowing
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(false);
  });

  it("should intervene on completed empty fake streams without streamResult (Stage 1 path)", async () => {
    const context = baseContext({
      responseData: {
        status: 200,
        isStream: true,
        isFakeStream: true,
        fakeStreamText: "",
        data: {
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        },
      },
      // Stage 1 early continuity has no streamResult yet
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.strategyName).toBe("EmptyOutput");
    expect(decision.modifiedBody.messages.at(-1).content).toContain("System Guard Note");
  });

  it("should NOT intervene when meaningful client output was already sent", async () => {
    const context = baseContext({
      responseData: {
        status: 200,
        isStream: true,
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
      streamResult: {
        isLengthTruncated: false,
        meaningfulClientOutputSent: true,
      } as any,
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(false);
  });

  it("should NOT intervene when fakeStreamText carries non-empty content", async () => {
    const context = baseContext({
      responseData: {
        status: 200,
        isStream: true,
        isFakeStream: true,
        fakeStreamText: "recovered answer from fake stream",
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
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(false);
  });

  it("should inject fallback message when onExhausted is called", async () => {
    const context = baseContext({
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
    });

    const modifiedResponse = await strategy.onExhausted(context);
    expect(modifiedResponse.data.choices[0].message.content).toContain("模型响应结果为空");
  });
});

describe("Sibling continuity strategies stream guards (anti-regression)", () => {
  it("MaxTokensTruncation still intervenes when finish_reason is length (non-stream)", async () => {
    const strategy = new MaxTokensTruncationStrategy();
    const decision = await strategy.evaluate(
      baseContext({
        responseData: {
          status: 200,
          data: {
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "partial..." },
                finish_reason: "length",
              },
            ],
          },
        },
        accumulatedCompletionText: "partial...",
      })
    );
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.strategyName).toBe("MaxTokensTruncation");
  });

  it("MaxTokensTruncation defers when live isStream without streamResult", async () => {
    const strategy = new MaxTokensTruncationStrategy();
    const decision = await strategy.evaluate(
      baseContext({
        responseData: {
          status: 200,
          isStream: true,
          data: {
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "partial..." },
                finish_reason: "length",
              },
            ],
          },
        },
        accumulatedCompletionText: "partial...",
      })
    );
    expect(decision.shouldIntervene).toBe(false);
  });

  it("MaxTokensTruncation still intervenes on completed fake streams without streamResult", async () => {
    const strategy = new MaxTokensTruncationStrategy();
    const decision = await strategy.evaluate(
      baseContext({
        responseData: {
          status: 200,
          isStream: true,
          isFakeStream: true,
          fakeStreamText: "partial...",
          data: {
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "partial..." },
                finish_reason: "length",
              },
            ],
          },
        },
        accumulatedCompletionText: "partial...",
      })
    );
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.strategyName).toBe("MaxTokensTruncation");
  });

  it("ReasoningExhaustion still intervenes on reasoning-only non-stream payloads", async () => {
    const strategy = new ReasoningExhaustionStrategy();
    const decision = await strategy.evaluate(
      baseContext({
        responseData: {
          status: 200,
          data: {
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  reasoning_content: "deep thought",
                },
                finish_reason: "stop",
              },
            ],
          },
        },
        accumulatedCompletionText: "",
      })
    );
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.strategyName).toBe("ReasoningExhaustion");
  });

  it("ReasoningExhaustion defers when live isStream without streamResult", async () => {
    const strategy = new ReasoningExhaustionStrategy();
    const decision = await strategy.evaluate(
      baseContext({
        responseData: {
          status: 200,
          isStream: true,
          data: {
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  reasoning_content: "deep thought",
                },
                finish_reason: "stop",
              },
            ],
          },
        },
        accumulatedCompletionText: "<think>deep thought</think>",
      })
    );
    expect(decision.shouldIntervene).toBe(false);
  });
});
