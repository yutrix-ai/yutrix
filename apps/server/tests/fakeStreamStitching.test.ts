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

const dbFile = "data/promptgate-test-fake-stream-stitch.sqlite";

describe("Fake Stream Stitching Integration", () => {
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
      username: "testuser_stitching",
      passwordHash: "dummy",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rawKey = "pg_key_stitch_" + crypto.randomUUID().slice(0, 8);
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
        await db.delete(routeAuthorizations).where(like(routeAuthorizations.routeId, "st-%"));
        await db.delete(endpointRoutes).where(like(endpointRoutes.id, "st-%"));
        await db.delete(endpoints).where(like(endpoints.id, "st-%"));
        await db.delete(providerModels).where(like(providerModels.providerId, "st-%"));
        await db.delete(providerApiKeys).where(like(providerApiKeys.providerId, "st-%"));
        await db.delete(providers).where(like(providers.id, "st-%"));
        await db.delete(requestLogs);
        await db.delete(chatLogs);
      } catch (e) {
        console.error("Cleanup error:", e);
      }
    }
  });

  it("handles fake stream stitching A+B+C with unified token sums", async () => {
    await db.insert(providers).values({
      id: "st-prov-1",
      name: "Stitch Provider",
      openaiBaseUrl: "https://api.openai.com/v1",
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerApiKeys).values({
      id: "st-prov-1-key",
      providerId: "st-prov-1",
      keyEncrypted: encryptText("sk-dummy"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: "st-prov-1",
      modelId: "test-model",
      displayName: "Test Model",
      enabled: true,
      createdAt: new Date(),
    });
    await db.insert(endpoints).values({
      id: "st-ep-1",
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
      id: "st-route-1",
      endpointId: "st-ep-1",
      name: "Test Route",
      providerId: "st-prov-1",
      providerProtocol: "openai",
      modelId: "test-model",
      strategyRoutingEnabled: false,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: "st-route-1",
      userId,
      createdAt: new Date(),
    });

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string, init?: any) => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response(JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "part-A" }, finish_reason: "length" }],
          usage: { prompt_tokens: 5, completion_tokens: 5 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      } else if (fetchCount === 2) {
        const body = JSON.parse(init.body);
        expect(body.messages[1].content).toBe("part-A");
        return new Response(JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "part-B" }, finish_reason: "length" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      } else {
        const body = JSON.parse(init.body);
        expect(body.messages[1].content).toBe("part-Apart-B");
        return new Response(JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "part-C" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 15, completion_tokens: 5 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    expect(response.statusCode).toBe(200);
    const bodyText = response.body;

    // Verify client output
    const lines = bodyText.split("\n").filter(l => l.startsWith("data: "));
    const chunks = lines.map(l => {
      const payload = l.replace("data: ", "").trim();
      return payload === "[DONE]" ? "[DONE]" : JSON.parse(payload);
    });

    let text = "";
    let finishReason: string | null = null;
    let doneCount = 0;
    let finalUsage: any = null;

    for (const chunk of chunks) {
      if (chunk === "[DONE]") {
        doneCount++;
      } else {
        if (chunk.choices?.[0]?.delta?.content) {
          text += chunk.choices[0].delta.content;
        }
        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
        if (chunk.usage) {
          finalUsage = chunk.usage;
        }
      }
    }

    expect(text).toBe("part-Apart-Bpart-C");
    expect(finishReason).toBe("stop");
    expect(doneCount).toBe(1);
    expect(fetchCount).toBe(3);

    // Verify token sum chunk usage in fake stream
    expect(finalUsage).toBeDefined();
    expect(finalUsage.prompt_tokens).toBe(30);
    expect(finalUsage.completion_tokens).toBe(15);
    expect(finalUsage.total_tokens).toBe(45);

    // Verify logs
    const reqLogs = await db.select().from(requestLogs);
    const cLogs = await db.select().from(chatLogs);

    expect(reqLogs.length).toBe(1);
    expect(reqLogs[0].inputTokens).toBe(30);
    expect(reqLogs[0].outputTokens).toBe(15);
    expect(reqLogs[0].totalTokens).toBe(45);

    expect(cLogs.length).toBe(1);
    expect(cLogs[0].outputText).toBe("part-Apart-Bpart-C");

    // Verify Action Log
    const compLog = loggedActions.find(act => act.code === "request.completed");
    expect(compLog).toBeDefined();
    expect(compLog.promptTokens).toBe(30);
    expect(compLog.completionTokens).toBe(15);
    expect(compLog.totalTokens).toBe(45);
  });
});
