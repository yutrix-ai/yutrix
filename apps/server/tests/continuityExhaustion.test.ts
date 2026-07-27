import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq, like } from "drizzle-orm";
import { encryptText } from "../src/utils/crypto";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import * as actionLogger from "../src/utils/actionLogger";
import { ContinuityEngine } from "../src/services/continuity/ContinuityEngine";

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

const dbFile = "data/promptgate-test-continuity-exhaustion.sqlite";

describe("Continuity Exhaustion Integration", () => {
  const fastify = Fastify();
  let apiKey = "";
  let userId = "";
  let savedDbFile: string | undefined;
  const loggedActions: any[] = [];
  let unsubscribe: (() => void) | undefined;
  let originalEvaluateAll: any;

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
      username: "testuser_exhaustion",
      passwordHash: "dummy",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rawKey = "pg_key_exh_" + crypto.randomUUID().slice(0, 8);
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

    originalEvaluateAll = ContinuityEngine.prototype.evaluateAll;
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
    ContinuityEngine.prototype.evaluateAll = originalEvaluateAll;
    if (db) {
      try {
        await db.delete(routeAuthorizations).where(like(routeAuthorizations.routeId, "exh-%"));
        await db.delete(endpointRoutes).where(like(endpointRoutes.id, "exh-%"));
        await db.delete(endpoints).where(like(endpoints.id, "exh-%"));
        await db.delete(providerModels).where(like(providerModels.providerId, "exh-%"));
        await db.delete(providerApiKeys).where(like(providerApiKeys.providerId, "exh-%"));
        await db.delete(providers).where(like(providers.id, "exh-%"));
        await db.delete(requestLogs);
        await db.delete(chatLogs);
      } catch (e) {
        console.error("Cleanup error:", e);
      }
    }
  });

  async function setupEnvironment(incomingProtocol: "openai" | "anthropic", providerProtocol: "openai" | "anthropic") {
    await db.insert(providers).values({
      id: "exh-prov-1",
      name: "Exhaustion Provider",
      openaiBaseUrl: providerProtocol === "openai" ? "https://api.openai.com/v1" : undefined,
      anthropicBaseUrl: providerProtocol === "anthropic" ? "https://api.anthropic.com" : undefined,
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerApiKeys).values({
      id: "exh-prov-1-key",
      providerId: "exh-prov-1",
      keyEncrypted: encryptText("sk-dummy"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: "exh-prov-1",
      modelId: "test-model",
      displayName: "Test Model",
      enabled: true,
      createdAt: new Date(),
    });
    await db.insert(endpoints).values({
      id: "exh-ep-1",
      userId,
      name: "Endpoint",
      path: incomingProtocol === "openai" ? "/v1/chat/completions" : "/v1/messages",
      incomingProtocol,
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(endpointRoutes).values({
      id: "exh-route-1",
      endpointId: "exh-ep-1",
      name: "Test Route",
      providerId: "exh-prov-1",
      providerProtocol,
      modelId: "test-model",
      strategyRoutingEnabled: false,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: "exh-route-1",
      userId,
      createdAt: new Date(),
    });
  }

  it("1. Real OpenAI SSE stream: stops at MAX limit and outputs finish_reason=length", async () => {
    await setupEnvironment("openai", "openai");

    // Override maxRetries to 10 so we test the MAX_CONTINUITY_CYCLES hard ceiling (which is 5)
    ContinuityEngine.prototype.evaluateAll = async function(context) {
      for (const strat of (this as any).strategies) {
        strat.maxRetries = 10;
      }
      return originalEvaluateAll.call(this, context);
    };

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string, init?: any) => {
      fetchCount++;
      const sseText = [
        `data: {"choices":[{"delta":{"content":"foo-${fetchCount}"}}]}`,
        `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":5}}`,
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
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    expect(response.statusCode).toBe(200);
    const bodyText = response.body;

    // Cycles: 1 initial fetch + 5 retries = 6 fetches total
    expect(fetchCount).toBe(6);

    // Assert text contains all parts sequentially with no duplication
    expect(bodyText).toContain("foo-1");
    expect(bodyText).toContain("foo-2");
    expect(bodyText).toContain("foo-3");
    expect(bodyText).toContain("foo-4");
    expect(bodyText).toContain("foo-5");
    expect(bodyText).toContain("foo-6");

    // The finish_reason="length" must be emitted exactly once
    const finishReasonMatches = bodyText.match(/"finish_reason":"length"/g) || [];
    expect(finishReasonMatches.length).toBe(1);

    // [DONE] must be emitted exactly once
    const doneMatches = bodyText.match(/data: \[DONE\]/g) || [];
    expect(doneMatches.length).toBe(1);

    // Action Log contains request.continuity.exhausted
    const exhLog = loggedActions.find(act => act.code === "request.continuity.exhausted");
    expect(exhLog).toBeDefined();
  });

  it("2. Fake stream OpenAI: stops at MAX limit and outputs finish_reason=length", async () => {
    await setupEnvironment("openai", "openai");

    ContinuityEngine.prototype.evaluateAll = async function(context) {
      for (const strat of (this as any).strategies) {
        strat.maxRetries = 10;
      }
      return originalEvaluateAll.call(this, context);
    };

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string, init?: any) => {
      fetchCount++;
      return new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: `part-${fetchCount}` }, finish_reason: "length" }],
        usage: { prompt_tokens: 5, completion_tokens: 5 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    expect(response.statusCode).toBe(200);
    const bodyText = response.body;

    expect(fetchCount).toBe(6);

    // The finish_reason="length" chunk must exist and be written once
    const lengthMatches = bodyText.match(/"finish_reason":"length"/g) || [];
    expect(lengthMatches.length).toBe(1);

    // DONE matches once
    const doneMatches = bodyText.match(/data: \[DONE\]/g) || [];
    expect(doneMatches.length).toBe(1);
  });

  it("3. OpenAI SSE -> Anthropic client: stops at MAX limit and outputs max_tokens", async () => {
    await setupEnvironment("anthropic", "openai");

    ContinuityEngine.prototype.evaluateAll = async function(context) {
      for (const strat of (this as any).strategies) {
        strat.maxRetries = 10;
      }
      return originalEvaluateAll.call(this, context);
    };

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string, init?: any) => {
      fetchCount++;
      const sseText = [
        `data: {"choices":[{"delta":{"content":"foo-${fetchCount}"}}]}`,
        `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":5}}`,
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
      url: "/v1/messages",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    expect(response.statusCode).toBe(200);
    const bodyText = response.body;

    expect(fetchCount).toBe(6);

    // Must emit content_block_stop
    expect(bodyText).toContain("content_block_stop");

    // Must emit message_delta.stop_reason="max_tokens" exactly once
    const stopReasonMatches = bodyText.match(/"stop_reason":"max_tokens"/g) || [];
    expect(stopReasonMatches.length).toBe(1);

    // Must emit message_stop exactly once
    const stopMatches = bodyText.match(/event: message_stop/g) || [];
    expect(stopMatches.length).toBe(1);
  });

  it("4. Native Anthropic max_tokens: bypasses and only fetches once", async () => {
    await setupEnvironment("anthropic", "anthropic");

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string, init?: any) => {
      fetchCount++;
      const sseText = [
        `event: message_start`,
        `data: {"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[],"model":"claude-3","stop_reason":null,"usage":{"input_tokens":5,"output_tokens":0}}}`,
        ``,
        `event: content_block_start`,
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
        ``,
        `event: content_block_delta`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Cut off"}}`,
        ``,
        `event: content_block_stop`,
        `data: {"type":"content_block_stop","index":0}`,
        ``,
        `event: message_delta`,
        `data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":10}}`,
        ``,
        `event: message_stop`,
        `data: {"type":"message_stop"}`,
        ``,
      ].join("\n");

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
      url: "/v1/messages",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchCount).toBe(1);

    // Verify stop reason max_tokens exists
    expect(response.body).toContain('"stop_reason":"max_tokens"');
  });
});
