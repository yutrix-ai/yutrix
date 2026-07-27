import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq, like } from "drizzle-orm";
import { encryptText } from "../src/utils/crypto";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import * as actionLogger from "../src/utils/actionLogger";

vi.mock("../src/utils/tokenizer", async () => {
  const actual = await vi.importActual<any>("../src/utils/tokenizer");
  return {
    ...actual,
    exactEstimateTokens: vi.fn(async (text) => {
      if (!text) return 0;
      return text.split(/\s+/).filter(Boolean).length || 1;
    }),
  };
});

let db: any;
let client: any;
let apiKeys: any;
let endpoints: any;
let endpointRoutes: any;
let providerApiKeys: any;
let providerModels: any;
let providers: any;
let routeAuthorizations: any;
let systemSettings: any;
let users: any;
let requestLogs: any;
let chatLogs: any;
let gatewayRoutes: any;

const dbFile = "data/promptgate-test-stitching-logs.sqlite";

describe("Gateway Stitching Logs and Anthropic Blocks Integration Tests", () => {
  const fastify = Fastify();
  let apiKey = "";
  let userId = "";
  let savedDbFile: string | undefined;
  const loggedActions: any[] = [];
  let unsubscribe: (() => void) | undefined;

  beforeAll(async () => {
    savedDbFile = process.env.DB_FILE;
    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));
    await import("../src/services/chatLogService");

    ({
      apiKeys,
      endpoints,
      endpointRoutes,
      providerApiKeys,
      providerModels,
      providers,
      routeAuthorizations,
      systemSettings,
      users,
      requestLogs,
      chatLogs,
    } = await import("../src/db/schema"));
    const routesMod = await import("../src/routes/gateway");
    gatewayRoutes = routesMod.default;

    await fastify.register(gatewayRoutes, { prefix: "" });
    await fastify.ready();

    await db.delete(systemSettings).where(eq(systemSettings.key, "allowUnknownHostFallback"));
    await db.insert(systemSettings).values({
      key: "allowUnknownHostFallback",
      value: "true",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: "testuser_stitching_logs",
      passwordHash: "dummy",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rawKey = "pg_key_st_" + crypto.randomUUID().slice(0, 8);
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      userId,
      name: "Test Key",
      keyPrefix: rawKey.substring(0, 8),
      keyHash: keyHash,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    apiKey = rawKey;

    unsubscribe = actionLogger.subscribeActionLogs((entry: any) => {
      loggedActions.push({
        code: entry.code || entry.params?.code,
        promptTokens: entry.promptTokens || entry.params?.promptTokens,
        completionTokens: entry.completionTokens || entry.params?.completionTokens,
        totalTokens: entry.totalTokens || entry.params?.totalTokens,
        modelId: entry.modelId || entry.params?.modelId,
      });
    });
  });

  afterAll(async () => {
    if (unsubscribe) unsubscribe();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await fastify.close();
    await closeAndCleanup(client, dbFile);
    if (savedDbFile !== undefined) {
      process.env.DB_FILE = savedDbFile;
    } else {
      delete process.env.DB_FILE;
    }
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    loggedActions.length = 0;
    if (db) {
      try {
        await db.delete(routeAuthorizations).where(like(routeAuthorizations.routeId, "%st-%"));
        await db.delete(endpointRoutes).where(like(endpointRoutes.id, "%st-%"));
        await db.delete(endpoints).where(like(endpoints.id, "%st-%"));
        await db.delete(providerModels).where(like(providerModels.providerId, "%st-%"));
        await db.delete(providerApiKeys).where(like(providerApiKeys.providerId, "%st-%"));
        await db.delete(providers).where(like(providers.id, "%st-%"));
        await db.delete(requestLogs);
        await db.delete(chatLogs);
      } catch (e) {
        console.error("Cleanup error:", e);
        throw e;
      }
    }
  });

  async function setupProvider({ provId, name, openaiBaseUrl, anthropicBaseUrl }: { provId: string, name: string, openaiBaseUrl?: string, anthropicBaseUrl?: string }) {
    await db.insert(providers).values({
      id: provId,
      name,
      openaiBaseUrl: openaiBaseUrl || null,
      anthropicBaseUrl: anthropicBaseUrl || null,
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const keyId = `key-${provId}`;
    await db.insert(providerApiKeys).values({
      id: keyId,
      providerId: provId,
      keyEncrypted: encryptText("sk-dummy"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(providerModels).values({
      id: `model-${provId}`,
      providerId: provId,
      modelId: "gpt-4o-mini",
      displayName: "gpt-4o-mini",
      inputTokenPricePerM: 15,
      outputTokenPricePerM: 15,
      enabled: true,
      active: true,
      createdAt: new Date(),
    });

    const epId = `ep-${provId}`;
    await db.insert(endpoints).values({
      id: epId,
      userId,
      name: `EP-${name}`,
      path: "/v1/chat/completions",
      virtualModelAlias: "gpt-4o-mini",
      loadBalanceMode: "priority",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(endpointRoutes).values({
      id: `route-${provId}`,
      endpointId: epId,
      providerId: provId,
      providerProtocol: openaiBaseUrl ? "openai" : "anthropic",
      modelId: "gpt-4o-mini",
      enabled: true,
      status: "active",
      weight: 100,
      priority: 1,
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function setupAnthropicProvider({ provId, name, openaiBaseUrl, anthropicBaseUrl }: { provId: string, name: string, openaiBaseUrl?: string, anthropicBaseUrl?: string }) {
    await db.insert(providers).values({
      id: provId,
      name,
      openaiBaseUrl: openaiBaseUrl || null,
      anthropicBaseUrl: anthropicBaseUrl || null,
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const keyId = `key-${provId}`;
    await db.insert(providerApiKeys).values({
      id: keyId,
      providerId: provId,
      keyEncrypted: encryptText("sk-dummy"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(providerModels).values({
      id: `model-${provId}`,
      providerId: provId,
      modelId: "test-model",
      displayName: "test-model",
      inputTokenPricePerM: 15,
      outputTokenPricePerM: 15,
      enabled: true,
      active: true,
      createdAt: new Date(),
    });

    const epId = `ep-${provId}`;
    await db.insert(endpoints).values({
      id: epId,
      userId,
      name: `EP-${name}`,
      path: "/v1/messages",
      virtualModelAlias: "test-model",
      loadBalanceMode: "priority",
      incomingProtocol: "anthropic",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(endpointRoutes).values({
      id: `route-${provId}`,
      endpointId: epId,
      providerId: provId,
      providerProtocol: openaiBaseUrl ? "openai" : "anthropic",
      modelId: "gpt-4o-mini",
      enabled: true,
      status: "active",
      weight: 100,
      priority: 1,
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it("1. Three-round real SSE successful stitching logs & cost", async () => {
    await setupProvider({
      provId: "st-prov-1",
      name: "Stitch Provider 1",
      openaiBaseUrl: "https://api.openai.com/v1",
    });

    let round = 0;
    vi.stubGlobal("fetch", async () => {
      round++;
      let sseText = "";
      if (round === 1) {
        sseText = [
          `data: {"choices":[{"delta":{"content":"part-A"}}]}`,
          `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}`,
          `data: {"choices":[{"choices":[],"delta":{},"finish_reason":"length"}]}`,
          `data: [DONE]`,
        ].join("\n\n") + "\n\n";
      } else if (round === 2) {
        sseText = [
          `data: {"choices":[{"delta":{"content":"part-B"}}]}`,
          `data: {"choices":[],"usage":{"prompt_tokens":15,"completion_tokens":5}}`,
          `data: {"choices":[{"choices":[],"delta":{},"finish_reason":"length"}]}`,
          `data: [DONE]`,
        ].join("\n\n") + "\n\n";
      } else {
        sseText = [
          `data: {"choices":[{"delta":{"content":"part-C"}}]}`,
          `data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":5}}`,
          `data: {"choices":[{"choices":[],"delta":{},"finish_reason":"stop"}]}`,
          `data: [DONE]`,
        ].join("\n\n") + "\n\n";
      }

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseText));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    if (response.statusCode !== 200) throw new Error('Status 500: ' + response.body);
    expect(response.statusCode).toBe(200);
    const bodyText = response.body;

    expect(bodyText).toContain("part-A");
    expect(bodyText).toContain("part-B");
    expect(bodyText).toContain("part-C");

    const reqLogs = await db.select().from(requestLogs);
    const chatLogsList = await db.select().from(chatLogs);

    expect(reqLogs.length).toBe(1);
    expect(chatLogsList.length).toBe(1);

    expect(reqLogs[0].usageStatus).toBe("success");
    expect(reqLogs[0].inputTokens).toBe(45); // 10 + 15 + 20
    expect(reqLogs[0].outputTokens).toBe(15); // 5 + 5 + 5
    expect(reqLogs[0].cost).toBeGreaterThan(0);

    const completedActions = loggedActions.filter(a => a.code === "request.completed");
    expect(completedActions.length).toBe(1);
  });

  it("2. Three-round fake-stream successful stitching logs & cost", async () => {
    await setupProvider({
      provId: "st-prov-2",
      name: "Stitch Provider 2",
      openaiBaseUrl: "https://api.openai.com/v1",
    });

    let round = 0;
    vi.stubGlobal("fetch", async () => {
      round++;
      let bodyData = {};
      if (round === 1) {
        bodyData = {
          choices: [{ message: { role: "assistant", content: "part-A" }, finish_reason: "length" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        };
      } else if (round === 2) {
        bodyData = {
          choices: [{ message: { role: "assistant", content: "part-B" }, finish_reason: "length" }],
          usage: { prompt_tokens: 15, completion_tokens: 5 }
        };
      } else {
        bodyData = {
          choices: [{ message: { role: "assistant", content: "part-C" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 5 }
        };
      }
      return new Response(JSON.stringify(bodyData), { status: 200, headers: { "content-type": "application/json" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    if (response.statusCode !== 200) {
      console.log("TEST 2 ERROR BODY:", response.body);
    }
    if (response.statusCode !== 200) throw new Error('Status 500: ' + response.body);
    expect(response.statusCode).toBe(200);

    const reqLogs = await db.select().from(requestLogs);
    const chatLogsList = await db.select().from(chatLogs);

    expect(reqLogs.length).toBe(1);
    expect(chatLogsList.length).toBe(1);
    expect(reqLogs[0].usageStatus).toBe("success");
    expect(reqLogs[0].inputTokens).toBe(45);
    expect(reqLogs[0].outputTokens).toBe(15);

    const completedActions = loggedActions.filter(a => a.code === "request.completed");
    expect(completedActions.length).toBe(1);
  });

  it("3. Default MaxTokensStrategy budget exhaustion", async () => {
    await setupProvider({
      provId: "st-prov-3",
      name: "Stitch Provider 3",
      openaiBaseUrl: "https://api.openai.com/v1",
    });

    // Make it always length truncate
    vi.stubGlobal("fetch", async () => {
      const sseText = [
        `data: {"choices":[{"delta":{"content":"exhaust"}}]}`,
        `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}`,
        `data: {"choices":[{"choices":[],"delta":{},"finish_reason":"length"}]}`,
        `data: [DONE]`,
      ].join("\n\n") + "\n\n";

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseText));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    if (response.statusCode !== 200) throw new Error('Status 500: ' + response.body);
    expect(response.statusCode).toBe(200);

    const reqLogs = await db.select().from(requestLogs);
    const chatLogsList = await db.select().from(chatLogs);

    expect(reqLogs.length).toBe(1);
    expect(chatLogsList.length).toBe(1);
    expect(reqLogs[0].usageStatus).not.toBe("queued");
    expect(reqLogs[0].usageStatus).not.toBe("processing");

    const completedActions = loggedActions.filter(a => a.code === "request.completed");
    expect(completedActions.length).toBe(1);

    const exhaustedActions = loggedActions.filter(a => a.code === "request.continuity.exhausted");
    expect(exhaustedActions.length).toBe(1);
  });

  it("4. Google OpenAI to Anthropic client fallback when usage is missing", async () => {
    await setupAnthropicProvider({
      provId: "st-prov-4",
      name: "Google Adapter",
      openaiBaseUrl: "https://generativelanguage.googleapis.com",
    });

    vi.stubGlobal("fetch", async () => {
      const googleResponse = {
        candidates: [
          {
            content: {
              parts: [{ text: "Hello from Google Gemma" }],
              role: "model"
            },
            finishReason: "STOP",
            index: 0
          }
        ]
        // NO usageMetadata provided
      };
      return new Response(JSON.stringify(googleResponse), { status: 200, headers: { "content-type": "application/json" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    });

    if (response.statusCode !== 200) throw new Error('Status 500: ' + response.body);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    if (response.statusCode !== 200 || !body.usage || body.usage.input_tokens === 0) {
      console.log("TEST 4 BODY:", response.body);
    }
    expect(body.usage).toBeDefined();
    expect(body.usage.input_tokens).toBeGreaterThan(0);
    expect(body.usage.output_tokens).toBeGreaterThan(0);

    const reqLogs = await db.select().from(requestLogs);
    expect(reqLogs.length).toBe(1);
    expect(reqLogs[0].usageStatus).toBe("estimated");
    expect(reqLogs[0].inputTokens).toBeGreaterThan(0);
    expect(reqLogs[0].outputTokens).toBeGreaterThan(0);
  });

  it("5. OpenAI reasoning_content-only, no usage local token estimation", async () => {
    await setupProvider({
      provId: "st-prov-5",
      name: "Provider 5",
      openaiBaseUrl: "https://api.openai.com/v1",
    });

    vi.stubGlobal("fetch", async () => {
      const responseData = {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              reasoning_content: "I think, therefore I am."
            },
            finish_reason: "stop"
          }
        ]
      };
      return new Response(JSON.stringify(responseData), { status: 200, headers: { "content-type": "application/json" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
    });

    if (response.statusCode !== 200) throw new Error('Status 500: ' + response.body);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.usage).toBeDefined();
    expect(body.usage.completion_tokens).toBeGreaterThan(0);

    const reqLogs = await db.select().from(requestLogs);
    expect(reqLogs.length).toBe(1);
    expect(reqLogs[0].usageStatus).toBe("estimated");
    expect(reqLogs[0].outputTokens).toBeGreaterThan(0);
  });

  it("6. Anthropic thinking-only, no usage local token estimation", async () => {
    await setupAnthropicProvider({
      provId: "st-prov-6",
      name: "Provider 6",
      anthropicBaseUrl: "https://api.anthropic.com",
    });

    vi.stubGlobal("fetch", async () => {
      const responseData = {
        content: [
          {
            type: "thinking",
            thinking: "Detailed reasoning steps",
            signature: "sig_abc"
          }
        ],
        stop_reason: "end_turn"
      };
      return new Response(JSON.stringify(responseData), { status: 200, headers: { "content-type": "application/json" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    });

    if (response.statusCode !== 200) throw new Error('Status 500: ' + response.body);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.usage).toBeDefined();
    expect(body.usage.output_tokens).toBeGreaterThan(0);

    const reqLogs = await db.select().from(requestLogs);
    expect(reqLogs.length).toBe(1);
    expect(reqLogs[0].usageStatus).toBe("estimated");
    expect(reqLogs[0].outputTokens).toBeGreaterThan(0);
  });

  it("7. OpenAI tool_calls-only, no usage local token estimation", async () => {
    await setupProvider({
      provId: "st-prov-7",
      name: "Provider 7",
      openaiBaseUrl: "https://api.openai.com/v1",
    });

    vi.stubGlobal("fetch", async () => {
      const responseData = {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: `{"location":"San Francisco"}`
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ]
      };
      return new Response(JSON.stringify(responseData), { status: 200, headers: { "content-type": "application/json" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
    });

    if (response.statusCode !== 200) throw new Error('Status 500: ' + response.body);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.usage).toBeDefined();
    expect(body.usage.completion_tokens).toBeGreaterThan(0);

    const reqLogs = await db.select().from(requestLogs);
    expect(reqLogs.length).toBe(1);
    expect(reqLogs[0].usageStatus).toBe("estimated");
    expect(reqLogs[0].outputTokens).toBeGreaterThan(0);
  });

  it("8. Anthropic tool_use-only, no usage local token estimation", async () => {
    await setupAnthropicProvider({
      provId: "st-prov-8",
      name: "Provider 8",
      anthropicBaseUrl: "https://api.anthropic.com",
    });

    vi.stubGlobal("fetch", async () => {
      const responseData = {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "get_weather",
            input: { location: "San Francisco" }
          }
        ],
        stop_reason: "tool_use"
      };
      return new Response(JSON.stringify(responseData), { status: 200, headers: { "content-type": "application/json" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    });

    if (response.statusCode !== 200) throw new Error('Status 500: ' + response.body);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.usage).toBeDefined();
    expect(body.usage.output_tokens).toBeGreaterThan(0);

    const reqLogs = await db.select().from(requestLogs);
    expect(reqLogs.length).toBe(1);
    expect(reqLogs[0].usageStatus).toBe("estimated");
    expect(reqLogs[0].outputTokens).toBeGreaterThan(0);
  });

  it("9. Mixed stream/fake round isolation", async () => {
    await setupProvider({
      provId: "st-prov-9",
      name: "Provider 9",
      openaiBaseUrl: "https://api.openai.com/v1",
    });

    let round = 0;
    vi.stubGlobal("fetch", async () => {
      round++;
      if (round === 1) {
        // SSE with real usage
        const sseText = [
          `data: {"choices":[{"delta":{"content":"foo"}}]}`,
          `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}`,
          `data: {"choices":[{"choices":[],"delta":{},"finish_reason":"length"}]}`,
          `data: [DONE]`,
        ].join("\n\n") + "\n\n";

        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseText));
            controller.close();
          }
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      } else {
        // Non-stream fake stream round with NO usage
        const bodyData = {
          choices: [{ message: { role: "assistant", content: "bar" }, finish_reason: "stop" }]
        };
        return new Response(JSON.stringify(bodyData), { status: 200, headers: { "content-type": "application/json" } });
      }
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    if (response.statusCode !== 200) throw new Error('Status 500: ' + response.body);
    expect(response.statusCode).toBe(200);

    const reqLogs = await db.select().from(requestLogs);
    expect(reqLogs.length).toBe(1);
    expect(reqLogs[0].usageStatus).toBe("estimated"); // fallback used for round 2
    expect(reqLogs[0].outputTokens).toBeGreaterThan(5); // 5 (round 1) + estimated for 'bar'
  });

  it("10. usage event before/after finish_reason=length DONE compatibility", async () => {
    await setupProvider({
      provId: "st-prov-10",
      name: "Provider 10",
      openaiBaseUrl: "https://api.openai.com/v1",
    });

    let round = 0;
    vi.stubGlobal("fetch", async () => {
      round++;
      let sseText = "";
      if (round === 1) {
        // Case A: usage event before length
        sseText = [
          `data: {"choices":[{"delta":{"content":"foo"}}]}`,
          `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}`,
          `data: {"choices":[{"choices":[],"delta":{},"finish_reason":"length"}]}`,
          `data: [DONE]`,
        ].join("\n\n") + "\n\n";
      } else {
        // Case B: length before usage
        sseText = [
          `data: {"choices":[{"delta":{"content":"bar"}}]}`,
          `data: {"choices":[{"choices":[],"delta":{},"finish_reason":"stop"}]}`,
          `data: {"choices":[],"usage":{"prompt_tokens":15,"completion_tokens":5}}`,
          `data: [DONE]`,
        ].join("\n\n") + "\n\n";
      }

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseText));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    if (response.statusCode !== 200) throw new Error('Status 500: ' + response.body);
    expect(response.statusCode).toBe(200);

    const bodyText = response.body;
    console.log("BODYTEXT IS: ", bodyText);
    const usageChunks = bodyText.match(/"usage"/g) || [];
    expect(usageChunks.length).toBeGreaterThanOrEqual(1); // at least one usage chunk (may have intermediate if run sequentially)
    expect(usageChunks.length).toBeLessThanOrEqual(2);

    const reqLogs = await db.select().from(requestLogs);
    expect(reqLogs.length).toBe(1);
    expect(reqLogs[0].inputTokens).toBe(25); // 10 + 15
    expect(reqLogs[0].outputTokens).toBe(10); // 5 + 5
  });
});
