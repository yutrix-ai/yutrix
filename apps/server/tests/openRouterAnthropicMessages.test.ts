import { describe, it, expect, vi, beforeAll } from "vitest";
import { executeGatewayRequest } from "../src/routes/gateway/gatewayExecutor";
import * as concurrencyMock from "../src/routes/gateway/concurrency";
import { FastifyRequest, FastifyReply } from "fastify";
import * as dbMock from "../src/db";
import * as upstreamMock from "../src/routes/gateway/upstream";

vi.mock("../src/db", () => {
  const dbMockObj = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: "1" }]),
  };
  return {
    db: dbMockObj,
    default: dbMockObj,
    ...dbMockObj
  };
});

vi.mock("../src/routes/gateway/upstream", () => ({
  executeUpstreamFetch: vi.fn(),
  createFakeStreamFromData: vi.fn(),
  googleGenAIStreamToOpenAIStream: vi.fn(),
  buildUpstreamHeaders: vi.fn().mockReturnValue({ "x-api-key": "sk-ant-test" }),
  determineUpstreamPath: vi.fn().mockReturnValue("/v1/messages"),
}));

vi.mock("../src/routes/gateway/cache", () => ({
  checkAndServeCachedResponse: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/services/tokenPricer", () => ({
  calculateCostForTokens: vi.fn().mockReturnValue(0),
}));

vi.mock("../src/utils/crypto", () => ({
  decryptText: vi.fn().mockReturnValue("sk-ant-test"),
}));

vi.mock("../src/routes/gateway/concurrency", () => ({
  getGlobalQueue: vi.fn().mockResolvedValue({ add: (fn: any) => fn() }),
  getApiKeyQueue: vi.fn().mockReturnValue({ add: (fn: any) => fn() }),
  getProviderQueue: vi.fn().mockReturnValue({ add: (fn: any) => fn() }),
  getModelQueue: vi.fn().mockReturnValue({ add: (fn: any) => fn() }),
}));

describe("OpenRouter Anthropic Native Skin", () => {
  beforeAll(() => {
    process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = "";
  });

  it("preserves Anthropic messages structure identically when routed via OpenRouter", async () => {
    const fakeAuthCtx = { userId: "u1", apiKeyRecord: { id: "k1" }, activeSessionId: "s1" };
    const req = {
      headers: { "x-api-key": "sk-ant-test" },
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      raw: { off: vi.fn() }
    } as unknown as FastifyRequest;

    const reply = {
      raw: { setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn(), off: vi.fn() },
      hijack: vi.fn(),
      status: vi.fn().mockReturnThis(),
      code: vi.fn().mockReturnThis(),
      send: vi.fn((err) => { console.error("REPLY SEND CALLED WITH:", err); })
    } as unknown as FastifyReply;

    const originalAnthropicBody = {
      model: "anthropic/claude-3.5-sonnet",
      max_tokens: 8192,
      messages: [
        { role: "user", content: "test" },
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "encrypted_stuff" },
            { type: "tool_use", id: "t1", name: "foo", input: {} }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "done" }
          ]
        }
      ]
    };

    const route = {
      id: "rt1",
      enabled: true,
      cacheEnabled: false,
      strategyRoutingEnabled: false,
      targets: JSON.stringify([{ providerId: "openrouter", modelId: "anthropic/claude-3.5-sonnet", weight: 1 }])
    };

    const provider = {
      id: "openrouter",
      name: "OpenRouter",
      enabled: true,
      openaiBaseUrl: "https://openrouter.ai/api/v1",
      anthropicBaseUrl: "https://openrouter.ai/api/v1",
      concurrencyLimit: 0,
      hourlyTokenLimit: 0,
      timeoutMs: 0,
      maxInputTokens: 8192,
      maxOutputTokens: 8192
    };
    const providerModel = { id: "pm1", maxInputTokens: 8192, maxOutputTokens: 8192 };
    const providerKey = { id: "k1", keyEncrypted: "encrypted", status: "active" };

    // Mock DB exactly for OpenRouter
    const dbMockImpl = vi.mocked(dbMock);
    dbMockImpl.select.mockImplementation((fields?: any) => {
      const builder = {
        from: () => builder,
        where: () => builder,
        limit: () => builder,
        execute: async () => {
          if (fields && fields.total) return [{ total: 0 }];
          return [];
        },
        then: (resolve: any) => {
          // This hack relies on the order of DB queries in gatewayExecutor
          // 1. providerList (providers)
          // 2. providerModels
          // 3. providerApiKeys
          return resolve([provider, providerModel, providerKey]);
        }
      };
      return builder as any;
    });

    vi.mocked(upstreamMock.executeUpstreamFetch).mockResolvedValue({
      status: 200,
      isStream: false,
      data: { id: "msg_123", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] }
    });

    const ctx = {
      request: req,
      reply,
      body: originalAnthropicBody,
      startTime: Date.now(),
      auth: fakeAuthCtx,
      routing: { incomingProtocol: "anthropic", reqPath: "/v1/messages", endpoint: {}, route, subdomainRecord: null },
      baseActionLog: {},
      reqLogId: "123",
      currentAttempt: { providerProtocol: "anthropic", providerId: "openrouter", modelId: "anthropic/claude-3.5-sonnet" },
      isStreaming: false,
      stream: {},
      activeModelConfig: { maxInputTokens: 8192, maxOutputTokens: 8192 },
      inputTokenLimit: { maxInputTokens: 0 },
      calculateCostForTokens: vi.fn().mockReturnValue(0),
      routingTrace: []
    };

    const abortHandlers = { abortUpstream: vi.fn(), abortOnRequestClose: vi.fn(), abortOnReplyClose: vi.fn() };
    await executeGatewayRequest(ctx as any, new AbortController(), 1, vi.fn(), abortHandlers);

    const callArgs = vi.mocked(upstreamMock.executeUpstreamFetch).mock.calls[0][0];

    // Key assertions:
    expect(callArgs.upstreamPath).toBe("/messages");
    expect(callArgs.upstreamHeaders.authorization).toBe("Bearer sk-ant-test");
    expect(callArgs.isAnthropicUpstream).toBe(true);

    // The body should be EXACTLY the original body, not transformed!
    expect(callArgs.finalBody).toStrictEqual(originalAnthropicBody);
  });
});
