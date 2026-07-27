import { describe, expect, it, vi } from "vitest";
import { forwardStream } from "../src/routes/gateway/streaming";
import * as streamForwarder from "../src/routes/gateway/streamForwarder";
import { openRouterAdapter } from "../src/routes/gateway/providerAdapters/openRouterAdapter";

// Mock streamForwarder
vi.mock("../src/routes/gateway/streamForwarder", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    forwardSSEStreamAdapted: vi.fn().mockResolvedValue({
      gotFirstChunk: true,
      isEmptyStream: false,
    }),
    forwardSSEStreamTransparent: vi.fn().mockResolvedValue({
      gotFirstChunk: true,
      isEmptyStream: false,
    }),
  };
});

describe("OpenRouter effectiveUpstreamProtocol logic", () => {
  it("routes Anthropic OpenRouter stream to transparent forwarder when incoming is Anthropic", async () => {
    // Setup Context
    const reply: any = { raw: { write: vi.fn() } };
    const responseData: any = { stream: new ReadableStream(), isFakeStream: false, status: 200, streamProtocol: "anthropic" };
    const ctx: any = {
      currentAttempt: {
        providerProtocol: "openai", // Originally OpenAI configured
        modelId: "anthropic/claude-3-5-sonnet",
      },
      stream: { estimatedPromptTokens: 10, accumulatedToolArgs: {} },
      startTime: Date.now(),
      auth: { apiKeyRecord: { id: "test-key" } },
      routing: { incomingProtocol: "anthropic" },
      activeModelConfig: {},
      activeProviderAdapter: openRouterAdapter,
      activeProviderAdapterContext: {
        incomingProtocol: "anthropic",
        providerProtocol: "openai",
        rawBaseUrl: "https://openrouter.ai/api/v1",
      },
    };
    const baseLog: any = {};

    await forwardStream(reply, responseData, ctx, baseLog);

    expect(streamForwarder.forwardSSEStreamAdapted).not.toHaveBeenCalled();
    expect(streamForwarder.forwardSSEStreamTransparent).toHaveBeenCalled();
  });

  it("routes to adapted forwarder when effective protocol is not anthropic but incoming is anthropic", async () => {
    // Setup Context where adapter returns non-anthropic effective protocol
    const reply: any = { raw: { write: vi.fn() } };
    const responseData: any = { stream: new ReadableStream(), isFakeStream: false, status: 200, streamProtocol: "openai" };

    const mockAdapter = {
      ...openRouterAdapter,
      effectiveUpstreamProtocol: () => "openai" // Force it to return openai
    };

    const ctx: any = {
      currentAttempt: {
        providerProtocol: "openai",
        modelId: "openai/gpt-4o",
      },
      stream: { estimatedPromptTokens: 10, accumulatedToolArgs: {} },
      startTime: Date.now(),
      auth: { apiKeyRecord: { id: "test-key" } },
      routing: { incomingProtocol: "anthropic" },
      activeModelConfig: {},
      activeProviderAdapter: mockAdapter,
      activeProviderAdapterContext: {
        incomingProtocol: "anthropic",
        providerProtocol: "openai",
        rawBaseUrl: "https://openrouter.ai/api/v1",
      },
    };
    const baseLog: any = {};

    // Clear mocks before test
    vi.mocked(streamForwarder.forwardSSEStreamAdapted).mockClear();
    vi.mocked(streamForwarder.forwardSSEStreamTransparent).mockClear();

    await forwardStream(reply, responseData, ctx, baseLog);

    expect(streamForwarder.forwardSSEStreamTransparent).not.toHaveBeenCalled();
    expect(streamForwarder.forwardSSEStreamAdapted).toHaveBeenCalled();
  });
});
