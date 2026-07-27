import { describe, it, expect } from "vitest";
import { createFakeStreamFromData } from "../src/routes/gateway/upstream";

/** Helper: read the entire fake stream and parse SSE chunks */
async function parseFakeStream(result: { fakeStream: ReadableStream }): Promise<{
  chunks: any[];
  raw: string;
}> {
  const reader = result.fakeStream.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();

  const chunks: any[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
      chunks.push(JSON.parse(trimmed.slice(6)));
    }
  }
  return { chunks, raw };
}

function makeDataObj(overrides: Record<string, any> = {}) {
  return {
    id: "test-id",
    object: "chat.completion",
    created: 1000,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Hello world",
          ...overrides,
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

describe("fakeStreamAdapterIsolation", () => {
  const modelId = "test-model";

  // --- Transparent provider (no policy) ---

  it("transparent provider: does NOT emit reasoning chunk", async () => {
    const dataObj = makeDataObj({ reasoning: "Some reasoning text" });
    const result = createFakeStreamFromData(dataObj, modelId);
    const { chunks } = await parseFakeStream(result);

    const reasoningChunks = chunks.filter(
      (c) => c.choices?.[0]?.delta?.reasoning !== undefined
    );
    expect(reasoningChunks).toHaveLength(0);
  });

  it("transparent provider: does NOT emit reasoning_details chunk", async () => {
    const dataObj = makeDataObj({
      reasoning_details: [{ type: "text", text: "Details here" }],
    });
    const result = createFakeStreamFromData(dataObj, modelId);
    const { chunks } = await parseFakeStream(result);

    const detailsChunks = chunks.filter(
      (c) => c.choices?.[0]?.delta?.reasoning_details !== undefined
    );
    expect(detailsChunks).toHaveLength(0);
  });

  it("transparent provider: still emits content and think-tag reasoning_content", async () => {
    const dataObj = makeDataObj({ content: "<think>Deep thought</think>\nActual content" });
    const result = createFakeStreamFromData(dataObj, modelId);
    const { chunks } = await parseFakeStream(result);

    // Should have reasoning_content from <think> tag
    const rcChunks = chunks.filter(
      (c) => c.choices?.[0]?.delta?.reasoning_content !== undefined
    );
    expect(rcChunks.length).toBeGreaterThanOrEqual(1);
    expect(rcChunks[0].choices[0].delta.reasoning_content).toBe("Deep thought");

    // Should have content chunk
    const contentChunks = chunks.filter(
      (c) => c.choices?.[0]?.delta?.content !== undefined
    );
    expect(contentChunks.length).toBeGreaterThanOrEqual(1);
    expect(contentChunks[0].choices[0].delta.content).toBe("Actual content");
  });

  // --- OpenRouter policy ---

  it("openrouter policy: emits reasoning chunk", async () => {
    const dataObj = makeDataObj({ reasoning: "Some reasoning text" });
    const result = createFakeStreamFromData(dataObj, modelId, "openai", {
      preserveFields: ["reasoning", "reasoning_details"],
    });
    const { chunks } = await parseFakeStream(result);

    const reasoningChunks = chunks.filter(
      (c) => c.choices?.[0]?.delta?.reasoning !== undefined
    );
    expect(reasoningChunks).toHaveLength(1);
    expect(reasoningChunks[0].choices[0].delta.reasoning).toBe("Some reasoning text");
  });

  it("openrouter policy: emits reasoning_details chunk", async () => {
    const dataObj = makeDataObj({
      reasoning_details: [{ type: "text", text: "Details here" }],
    });
    const result = createFakeStreamFromData(dataObj, modelId, "openai", {
      preserveFields: ["reasoning", "reasoning_details"],
    });
    const { chunks } = await parseFakeStream(result);

    const detailsChunks = chunks.filter(
      (c) => c.choices?.[0]?.delta?.reasoning_details !== undefined
    );
    expect(detailsChunks).toHaveLength(1);
  });

  // --- General invariants ---

  it("does not duplicate finish chunk", async () => {
    const dataObj = makeDataObj({
      reasoning: "R",
      reasoning_content: "RC",
    });
    const result = createFakeStreamFromData(dataObj, modelId, "openai", {
      preserveFields: ["reasoning"],
    });
    const { chunks: allChunks } = await parseFakeStream(result);

    const finishChunks = allChunks.filter(
      (c) => c.choices?.[0]?.finish_reason !== null && c.choices?.[0]?.finish_reason !== undefined
    );
    expect(finishChunks).toHaveLength(1);
  });

  it("does not duplicate [DONE]", async () => {
    const { fakeStream } = createFakeStreamFromData(
      { choices: [{ index: 0, message: { role: "assistant", content: "test" }, finish_reason: "stop" }] },
      "test-model"
    );
    const result = await parseFakeStream({ fakeStream });
    const doneLines = result.raw.split("\n").filter((l: string) => l === "data: [DONE]");
    expect(doneLines).toHaveLength(1);
  });

  it("preserves usage in final chunk", async () => {
    const { fakeStream } = createFakeStreamFromData(
      {
        choices: [{ index: 0, message: { role: "assistant", content: "test" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      "test-model"
    );
    const result = await parseFakeStream({ fakeStream });
    const allChunks = result.chunks;
    const usageChunk = allChunks.find(c => c.usage);
    expect(usageChunk).toBeDefined();
    expect(usageChunk!.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it("tool calls still work regardless of policy", async () => {
    const dataObj = {
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"NY"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    const result = createFakeStreamFromData(dataObj, modelId);
    expect(result.isToolCalls).toBe(true);

    const { chunks } = await parseFakeStream(result);
    const tcChunk = chunks.find(
      (c) => c.choices?.[0]?.delta?.tool_calls !== undefined
    );
    expect(tcChunk).toBeDefined();
    expect(tcChunk!.choices[0].delta.tool_calls[0].function.name).toBe("get_weather");
  });
});

import { restoreFakeStreamIfNeeded } from "../src/routes/gateway/gatewayExecutor";

describe("gatewayExecutor restoreFakeStreamIfNeeded", () => {
  it("respects the active adapter policy when converting non-stream to stream", () => {
    const mockCtx = {
      isStreaming: true,
      activeProviderAdapter: {
        getRequestPolicy: () => ({ preserveFakeStreamFields: ["reasoning"] })
      },
      activeProviderAdapterContext: {}
    };
    const responseData = {
      status: 200,
      isStream: false,
      responseProtocol: "openai",
      data: makeDataObj({ reasoning: "some reasoning text" })
    };
    const currentAttempt = { modelId: "test-model" };

    restoreFakeStreamIfNeeded(mockCtx, responseData, currentAttempt);

    expect(responseData.isStream).toBe(true);
    expect(responseData.isFakeStream).toBe(true);
    expect(responseData.stream).toBeDefined();
  });
});
