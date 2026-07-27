import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq, like } from "drizzle-orm";
import { encryptText } from "../src/utils/crypto";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import * as actionLogger from "../src/utils/actionLogger";
import * as tokenizer from "../src/utils/tokenizer";

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

const dbFile = "data/promptgate-test-usage-fallback-stitching.sqlite";

describe("Gateway Usage Fallback and Stitching Integration Matrix", () => {
  const fastify = Fastify();
  let apiKey = "";
  let userId = "";
  let savedDbFile: string | undefined;
  const loggedActions: any[] = [];
  let unsubscribe: (() => void) | undefined;
  let testCounter = 0;

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
      username: "testuser_fallback",
      passwordHash: "dummy",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rawKey = "pg_key_fb_" + crypto.randomUUID().slice(0, 8);
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
        await db.delete(routeAuthorizations).where(like(routeAuthorizations.routeId, "%fb-%"));
        await db.delete(endpointRoutes).where(like(endpointRoutes.id, "%fb-%"));
        await db.delete(endpoints).where(like(endpoints.id, "%fb-%"));
        await db.delete(providerModels).where(like(providerModels.providerId, "%fb-%"));
        await db.delete(providerApiKeys).where(like(providerApiKeys.providerId, "%fb-%"));
        await db.delete(providers).where(like(providers.id, "%fb-%"));
        await db.delete(requestLogs);
        await db.delete(chatLogs);
      } catch (e) {
        console.error("Cleanup error in afterEach:", e);
        throw e;
      }
    }
  });

  async function setupEnvironment(incomingProtocol: "openai" | "anthropic", providerProtocol: "openai" | "anthropic") {
    testCounter++;
    const suffix = `fb-${testCounter}`;

    await db.insert(providers).values({
      id: suffix,
      name: `Fallback Provider ${suffix}`,
      openaiBaseUrl: providerProtocol === "openai" ? "https://fb.test/v1" : null,
      anthropicBaseUrl: providerProtocol === "anthropic" ? "https://fb.test/v1" : null,
      concurrencyLimit: 10,
      enabled: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const encryptedKey = encryptText("fb-key");
    await db.insert(providerApiKeys).values({
      id: `${suffix}-key`,
      providerId: suffix,
      keyEncrypted: encryptedKey,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(providerModels).values({
      id: `${suffix}-pm`,
      providerId: suffix,
      modelId: "test-model",
      displayName: "test-model",
      enabled: 1,
      active: 1,
      createdAt: new Date(),
    });

    await db.insert(endpoints).values({
      id: `${suffix}-ep`,
      userId,
      name: `Test Endpoint ${suffix}`,
      path: "/v1/chat/completions",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(endpointRoutes).values({
      id: `${suffix}-route`,
      name: `Test Route ${suffix}`,
      endpointId: `${suffix}-ep`,
      providerId: suffix,
      providerProtocol,
      modelId: "test-model",
      priority: 1,
      enabled: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(routeAuthorizations).values({
      id: `${suffix}-auth`,
      routeId: `${suffix}-route`,
      apiKeyId: (await db.select().from(apiKeys).where(eq(apiKeys.keyPrefix, apiKey.substring(0, 8))))[0].id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it("1. Non-streaming, complete provider usage: success status", async () => {
    await setupEnvironment("openai", "openai");

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "complete usage content" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.usage).toBeDefined();
    expect(body.usage.prompt_tokens).toBe(12);
    expect(body.usage.completion_tokens).toBe(24);

    const logs = await db.select().from(requestLogs);
    expect(logs.length).toBe(1);
    expect(logs[0].inputTokens).toBe(12);
    expect(logs[0].outputTokens).toBe(24);
    expect(logs[0].usageStatus).toBe("success");

    const compLog = loggedActions.find(act => act.code === "request.completed");
    expect(compLog).toBeDefined();
    expect(compLog.promptTokens).toBe(12);
    expect(compLog.completionTokens).toBe(24);
  });

  it("2. Non-streaming, no provider usage: estimated status via exactEstimateTokens fallback", async () => {
    await setupEnvironment("openai", "openai");

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    // Inject custom estimator for predictable counts
    vi.spyOn(tokenizer, "exactEstimateTokens").mockImplementation(async (text: string) => {
      return text.length; // predictability
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    });

    expect(response.statusCode).toBe(200);

    const logs = await db.select().from(requestLogs);
    expect(logs.length).toBe(1);
    expect(logs[0].inputTokens).toBeGreaterThan(0);
    expect(logs[0].outputTokens).toBe(11); // "Hello world" length is 11
    expect(logs[0].usageStatus).toBe("estimated");

    const body = JSON.parse(response.body);
    expect(body.usage).toBeDefined();
    expect(body.usage.prompt_tokens).toBe(logs[0].inputTokens);
    expect(body.usage.completion_tokens).toBe(11);
  });

  it("3. Non-streaming, partial provider usage (missing input_tokens): estimated status", async () => {
    await setupEnvironment("openai", "openai");

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "Predictable output" }, finish_reason: "stop" }],
        usage: { completion_tokens: 15 } // input_tokens missing!
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    vi.spyOn(tokenizer, "exactEstimateTokens").mockImplementation(async (text: string) => {
      return text.length;
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    });

    expect(response.statusCode).toBe(200);

    const logs = await db.select().from(requestLogs);
    expect(logs.length).toBe(1);
    expect(logs[0].outputTokens).toBe(15); // uses provider value
    expect(logs[0].inputTokens).toBeGreaterThan(0); // uses estimated value
    expect(logs[0].usageStatus).toBe("estimated");
  });

  it("4. Non-streaming, local estimation failed: missing status", async () => {
    await setupEnvironment("openai", "openai");

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "content" }, finish_reason: "stop" }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    vi.spyOn(tokenizer, "exactEstimateTokens").mockImplementation(async () => {
      return 0; // Fail/no tokens returned
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    });

    expect(response.statusCode).toBe(200);

    const logs = await db.select().from(requestLogs);
    expect(logs.length).toBe(1);
    expect(logs[0].inputTokens).toBe(22);
    expect(logs[0].outputTokens).toBe(0);
    expect(logs[0].usageStatus).toBe("missing");
  });

  it("5. Ordinary SSE, no usage: estimated status and client output matches", async () => {
    await setupEnvironment("openai", "openai");

    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "chunk-1" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "chunk-2" } }] })}`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
      `data: [DONE]`
    ].join("\n\n") + "\n\n";

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      return new Response(sseChunks, { status: 200, headers: { "content-type": "text/event-stream" } });
    }));

    vi.spyOn(tokenizer, "exactEstimateTokens").mockImplementation(async (text: string) => {
      return text.length;
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    expect(response.statusCode).toBe(200);

    const logs = await db.select().from(requestLogs);
    expect(logs.length).toBe(1);
    expect(logs[0].outputTokens).toBe(14); // "chunk-1chunk-2" length is 14
    expect(logs[0].usageStatus).toBe("estimated");
  });

  it("6. Fake stream, no usage: estimated status and inject usage block in final chunk", async () => {
    await setupEnvironment("openai", "openai");

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "fake stream text" }, finish_reason: "stop" }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    vi.spyOn(tokenizer, "exactEstimateTokens").mockImplementation(async (text: string) => {
      return text.length;
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    expect(response.statusCode).toBe(200);
    const bodyText = response.body;

    // Check final usage chunk
    const lines = bodyText.split("\n").filter(l => l.startsWith("data: "));
    const finalChunk = JSON.parse(lines[lines.length - 2].replace("data: ", ""));
    expect(finalChunk.usage).toBeDefined();
    expect(finalChunk.usage.prompt_tokens).toBeGreaterThan(0);
    expect(finalChunk.usage.completion_tokens).toBe(16); // "fake stream text" length is 16

    const logs = await db.select().from(requestLogs);
    expect(logs.length).toBe(1);
    expect(logs[0].outputTokens).toBe(16);
    expect(logs[0].usageStatus).toBe("estimated");
  });

  it("7. Cache read/write tokens persistence", async () => {
    await setupEnvironment("openai", "openai");

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "cached content" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 15 },
          cache_creation_input_tokens: 5 // Simulated mix
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    });

    expect(response.statusCode).toBe(200);

    const logs = await db.select().from(requestLogs);
    expect(logs.length).toBe(1);
    expect(logs[0].cacheReadTokens).toBe(15);
  });
});
