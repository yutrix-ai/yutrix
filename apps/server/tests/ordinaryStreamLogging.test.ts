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
let requestLogs: any;
let chatLogs: any;
let gatewayRoutes: any;

const dbFile = "data/promptgate-test-ordinary-stream.sqlite";

describe("Ordinary Stream Logging Integration", () => {
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
      username: "testuser_ordinary",
      passwordHash: "dummy",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rawKey = "pg_key_ord_" + crypto.randomUUID().slice(0, 8);
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
        await db.delete(routeAuthorizations).where(like(routeAuthorizations.routeId, "ord-%"));
        await db.delete(endpointRoutes).where(like(endpointRoutes.id, "ord-%"));
        await db.delete(endpoints).where(like(endpoints.id, "ord-%"));
        await db.delete(providerModels).where(like(providerModels.providerId, "ord-%"));
        await db.delete(providerApiKeys).where(like(providerApiKeys.providerId, "ord-%"));
        await db.delete(providers).where(like(providers.id, "ord-%"));
        await db.delete(requestLogs);
        await db.delete(chatLogs);
      } catch (e) {
        console.error("Cleanup error:", e);
      }
    }
  });

  it("handles ordinary stream logging without token or text duplication", async () => {
    await db.insert(providers).values({
      id: "ord-prov-1",
      name: "Stream Provider",
      openaiBaseUrl: "https://api.openai.com/v1",
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerApiKeys).values({
      id: "ord-prov-1-key",
      providerId: "ord-prov-1",
      keyEncrypted: encryptText("sk-dummy"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: "ord-prov-1",
      modelId: "test-model",
      displayName: "Test Model",
      enabled: true,
      createdAt: new Date(),
    });
    await db.insert(endpoints).values({
      id: "ord-ep-1",
      userId,
      name: "Endpoint",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(endpointRoutes).values({
      id: "ord-route-1",
      endpointId: "ord-ep-1",
      name: "Test Route",
      providerId: "ord-prov-1",
      providerProtocol: "openai",
      modelId: "test-model",
      strategyRoutingEnabled: false,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: "ord-route-1",
      userId,
      createdAt: new Date(),
    });

    vi.stubGlobal("fetch", async (url: string, init?: any) => {
      const sseText = [
        `data: {"choices":[{"delta":{"content":"hello"}}]}`,
        `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
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

    // Verify client output only has 'hello' once
    const matches = bodyText.match(/"content":"hello"/g) || [];
    expect(matches.length).toBe(1);

    // Verify logs
    const reqLogs = await db.select().from(requestLogs);
    const cLogs = await db.select().from(chatLogs);

    expect(reqLogs.length).toBe(1);
    expect(reqLogs[0].inputTokens).toBe(10);
    expect(reqLogs[0].outputTokens).toBe(5);
    expect(reqLogs[0].totalTokens).toBe(15);

    expect(cLogs.length).toBe(1);
    expect(cLogs[0].outputText).toBe("hello");

    // Verify Action Log
    const compLog = loggedActions.find(act => act.code === "request.completed");
    expect(compLog).toBeDefined();
    expect(compLog.promptTokens).toBe(10);
    expect(compLog.completionTokens).toBe(5);
    expect(compLog.totalTokens).toBe(15);
  });
});
