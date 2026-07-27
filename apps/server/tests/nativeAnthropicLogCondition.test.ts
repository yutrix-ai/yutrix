import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq, like } from "drizzle-orm";
import { encryptText } from "../src/utils/crypto";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import * as actionLogger from "../src/utils/actionLogger";

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
let gatewayRoutes: any;

const dbFile = "data/promptgate-test-anthropic-log-condition.sqlite";

describe("Native Anthropic Log Condition Integration", () => {
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
      username: "testuser_logcond",
      passwordHash: "dummy",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rawKey = "pg_key_logc_" + crypto.randomUUID().slice(0, 8);
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
        await db.delete(routeAuthorizations).where(like(routeAuthorizations.routeId, "logc-%"));
        await db.delete(endpointRoutes).where(like(endpointRoutes.id, "logc-%"));
        await db.delete(endpoints).where(like(endpoints.id, "logc-%"));
        await db.delete(providerModels).where(like(providerModels.providerId, "logc-%"));
        await db.delete(providerApiKeys).where(like(providerApiKeys.providerId, "logc-%"));
        await db.delete(providers).where(like(providers.id, "logc-%"));
      } catch (e) {
        console.error("Cleanup error:", e);
      }
    }
  });

  it("OpenAI source -> Anthropic responseProtocol: does NOT log request.continuity.native_anthropic_not_retried", async () => {
    await db.insert(providers).values({
      id: "logc-prov-1",
      name: "Logc Provider",
      openaiBaseUrl: "https://api.openai.com/v1",
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerApiKeys).values({
      id: "logc-prov-1-key",
      providerId: "logc-prov-1",
      keyEncrypted: encryptText("sk-dummy"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: "logc-prov-1",
      modelId: "test-model",
      displayName: "Test Model",
      enabled: true,
      createdAt: new Date(),
    });
    await db.insert(endpoints).values({
      id: "logc-ep-1",
      userId,
      name: "Endpoint",
      path: "/v1/messages",
      incomingProtocol: "anthropic",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(endpointRoutes).values({
      id: "logc-route-1",
      endpointId: "logc-ep-1",
      name: "Test Route",
      providerId: "logc-prov-1",
      providerProtocol: "openai",
      modelId: "test-model",
      strategyRoutingEnabled: false,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: "logc-route-1",
      userId,
      createdAt: new Date(),
    });

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string, init?: any) => {
      fetchCount++;
      // OpenAI source payload
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

    // Make the gateway request: incoming is Anthropic (calls /v1/messages)
    // but the route uses providerProtocol = "openai"
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    expect(response.statusCode).toBe(200);

    // Verify it continued (more than 1 fetch, since it's OpenAI source)
    expect(fetchCount).toBeGreaterThan(1);

    // Verify we did NOT log native_anthropic_not_retried
    const retryLog = loggedActions.find(act => act.code === "request.continuity.native_anthropic_not_retried");
    expect(retryLog).toBeUndefined();
  });
});
