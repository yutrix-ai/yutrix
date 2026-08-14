import { describe, expect, it } from "vitest";
import { EmptyOutputStrategy } from "../src/services/continuity/strategies/EmptyOutputStrategy";
import { MaxTokensTruncationStrategy } from "../src/services/continuity/strategies/MaxTokensTruncationStrategy";
import { ReasoningExhaustionStrategy } from "../src/services/continuity/strategies/ReasoningExhaustionStrategy";
import { ContinuityContext } from "../src/services/continuity/types";
import {
  shouldWithholdEmptyTerminal,
  shouldBufferNativeAnthropicPrelude,
  wouldLogZeroEmptyCompletion,
} from "../src/services/continuity/emptyCompletionDecision";

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

describe("shouldWithholdEmptyTerminal (shared OpenAI + Anthropic)", () => {
  it("holds OpenAI empty stop and [DONE] when nothing visible was sent", () => {
    expect(shouldWithholdEmptyTerminal({
      visibleClientOutputSent: false,
      finishReason: "stop",
    })).toBe(true);
    expect(shouldWithholdEmptyTerminal({
      visibleClientOutputSent: false,
      isDone: true,
    })).toBe(true);
  });

  it("holds Anthropic empty message_delta/message_stop", () => {
    expect(shouldWithholdEmptyTerminal({
      visibleClientOutputSent: false,
      anthropicEventType: "message_stop",
    })).toBe(true);
    expect(shouldWithholdEmptyTerminal({
      visibleClientOutputSent: false,
      anthropicEventType: "message_delta",
      anthropicStopReason: "end_turn",
    })).toBe(true);
  });

  it("does not hold after visible text or tool/reasoning content", () => {
    expect(shouldWithholdEmptyTerminal({
      visibleClientOutputSent: true,
      finishReason: "stop",
    })).toBe(false);
    expect(shouldWithholdEmptyTerminal({
      visibleClientOutputSent: false,
      eventHasSemanticContent: true,
      finishReason: "stop",
    })).toBe(false);
    expect(shouldWithholdEmptyTerminal({
      visibleClientOutputSent: false,
      hasReasoningBuffer: true,
      isDone: true,
    })).toBe(false);
  });

  it("buffers native Anthropic message_start until visible content or withhold", () => {
    expect(shouldBufferNativeAnthropicPrelude({
      visibleClientOutputSent: false,
      anthropicEventType: "message_start",
    })).toBe(true);
    expect(shouldBufferNativeAnthropicPrelude({
      visibleClientOutputSent: false,
      eventHasSemanticContent: true,
      anthropicEventType: "content_block_delta",
    })).toBe(false);
    expect(shouldBufferNativeAnthropicPrelude({
      visibleClientOutputSent: true,
      anthropicEventType: "message_start",
    })).toBe(false);
  });
});

describe("wouldLogZeroEmptyCompletion (shared withhold/retry signal)", () => {
  const helloBody = {
    model: "gemini-3.6-flash",
    messages: [{ role: "user", content: "hello" }],
  };

  it("treats omitted usage plus a non-empty request as in/0/in", () => {
    expect(wouldLogZeroEmptyCompletion(
      { status: 200, data: { choices: [{ message: { content: "" }, finish_reason: "stop" }] } },
      undefined,
      helloBody,
    )).toBe(true);
  });

  it("does not treat omitted usage as in/0/in when the request has no input", () => {
    expect(wouldLogZeroEmptyCompletion(
      { status: 200, data: { choices: [{ message: { content: "" }, finish_reason: "stop" }] } },
      undefined,
      { model: "gemini-3.6-flash", messages: [] },
    )).toBe(false);
  });

  it("does not treat an explicit positive completion as empty even if the request has input", () => {
    expect(wouldLogZeroEmptyCompletion(
      {
        status: 200,
        data: {
          choices: [{ message: { content: "" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 539, completion_tokens: 2, total_tokens: 541 },
        },
      },
      undefined,
      helloBody,
    )).toBe(false);
  });

  it("still treats explicit completion_tokens=0 as empty", () => {
    expect(wouldLogZeroEmptyCompletion(
      {
        status: 200,
        data: {
          usage: { prompt_tokens: 40, completion_tokens: 0, total_tokens: 40 },
        },
      },
    )).toBe(true);
  });
});

describe("EmptyOutputStrategy Unit Tests", () => {
  const strategy = new EmptyOutputStrategy();

  it("has correct strategy name and default maxRetries", () => {
    expect(strategy.name).toBe("EmptyOutput");
    expect(strategy.maxRetries).toBe(1);
  });

  it("retries the same body when provider reports completion_tokens=0", async () => {
    const originalBody = {
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "hello" }],
    };
    const context = baseContext({
      originalBody,
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
    expect(decision.modifiedBody).toBe(originalBody);
    expect(decision.modifiedBody.messages).toHaveLength(1);
  });

  it("retries Anthropic empty content when usage is omitted but the request has input", async () => {
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
    expect(decision.modifiedBody.messages).toHaveLength(1);
  });

  it("should intervene for Anthropic empty content when output_tokens is 0", async () => {
    const context = baseContext({
      responseData: {
        status: 200,
        data: {
          type: "message",
          role: "assistant",
          content: [],
          stop_reason: "end_turn",
          usage: { input_tokens: 80, output_tokens: 0 },
        },
      },
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.modifiedBody.messages).toHaveLength(1);
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
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.strategyName).toBe("EmptyOutput");
    expect(decision.modifiedBody.messages.at(-1).content).toBe("hello");
  });

  it("retries when live SSE trailer reports completion_tokens=0", async () => {
    const originalBody = {
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "hello" }],
    };
    const context = baseContext({
      originalBody,
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
        roundStreamUsage: {
          usage: { prompt_tokens: 2916, completion_tokens: 0, total_tokens: 2916 },
        },
      },
      streamResult: {
        isLengthTruncated: false,
        withheldEmptyTerminal: true,
        visibleClientOutputSent: false,
        meaningfulClientOutputSent: false,
      },
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.modifiedBody).toBe(originalBody);
  });

  it("retries when usage is omitted and the request would estimate in>0", async () => {
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

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.strategyName).toBe("EmptyOutput");
  });

  it("does not retry omitted usage when the request has no input material", async () => {
    const context = baseContext({
      originalBody: { model: "gemini-3.6-flash", messages: [] },
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

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(false);
  });

  it("retries withheld empty terminal when usage is omitted and the request has input", async () => {
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
        withheldEmptyTerminal: true,
        visibleClientOutputSent: false,
        meaningfulClientOutputSent: false,
      },
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.modifiedBody.messages).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("does not retry a withheld empty terminal when the trailer reports completion_tokens>0", async () => {
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
          usage: { prompt_tokens: 539, completion_tokens: 2, total_tokens: 541 },
        },
      },
      streamResult: {
        isLengthTruncated: false,
        withheldEmptyTerminal: true,
        visibleClientOutputSent: false,
        meaningfulClientOutputSent: false,
      },
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(false);
  });

  it("retries sidecar / title-generation when the completed log would be in/0/in", async () => {
    const context = baseContext({
      requestClass: "client_sidecar",
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
          usage: { prompt_tokens: 40, completion_tokens: 0, total_tokens: 40 },
        },
      },
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(true);
  });

  it("retries when resolved log totals are in/0/in even without a usage field", async () => {
    const context = baseContext({
      roundUsage: { inputTokens: 2916, outputTokens: 0 },
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

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(true);
  });

  it("should NOT intervene after stop/[DONE] was already sent to the client", async () => {
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
          usage: { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 },
        },
      },
      streamResult: {
        isLengthTruncated: false,
        terminalEventSent: true,
        visibleClientOutputSent: false,
        meaningfulClientOutputSent: false,
      },
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(false);
  });

  it("should NOT intervene when visible client output was already sent", async () => {
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
        visibleClientOutputSent: true,
        meaningfulClientOutputSent: true,
      },
    });

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(false);
  });

  it("should NOT treat reasoning-only as zero-completion (ReasoningExhaustion owns that)", async () => {
    const context = baseContext({
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
                reasoning_content: "ok",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 0, total_tokens: 20 },
        },
      },
      streamResult: {
        isLengthTruncated: false,
        meaningfulClientOutputSent: true,
        visibleClientOutputSent: false,
      },
      accumulatedCompletionText: "",
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
    const fallback = modifiedResponse.data.choices[0].message.content;
    expect(fallback).toContain("0 output tokens");
    expect(fallback).toContain("Please resend");
    expect(fallback).toContain("0 输出 token");
    expect(fallback).toContain("请重新发送");
    expect(fallback).not.toMatch(/换模型|switch models/i);
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
