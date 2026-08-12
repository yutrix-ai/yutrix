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

const dbFile = "data/promptgate-test-empty-output-integration.sqlite";

describe("Empty Output Auto-Continuation Integration", () => {
  const fastify = Fastify();
  let apiKey = "";
  let userId = "";
  let savedDbFile: string | undefined;
  const loggedActions: any[] = [];
  let unsubscribe: (() => void) | undefined;

  beforeAll(async () => {
    savedDbFile = process.env.DB_FILE;
    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));

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
      username: "testuser_empty_out",
      passwordHash: "dummy",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rawKey = "pg_key_empty_" + crypto.randomUUID().slice(0, 8);
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
        await db.delete(routeAuthorizations).where(like(routeAuthorizations.routeId, "emp-%"));
        await db.delete(endpointRoutes).where(like(endpointRoutes.id, "emp-%"));
        await db.delete(endpoints).where(like(endpoints.id, "emp-%"));
        await db.delete(providerModels).where(like(providerModels.providerId, "emp-%"));
        await db.delete(providerApiKeys).where(like(providerApiKeys.providerId, "emp-%"));
        await db.delete(providers).where(like(providers.id, "emp-%"));
        await db.delete(requestLogs);
        await db.delete(chatLogs);
      } catch (e) {
        console.error("Cleanup error:", e);
      }
    }
  });

  async function setupEnvironment() {
    await db.insert(providers).values({
      id: "emp-prov-1",
      name: "Empty Output Provider",
      openaiBaseUrl: "https://api.openai.com/v1",
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerApiKeys).values({
      id: "emp-prov-1-key",
      providerId: "emp-prov-1",
      keyEncrypted: encryptText("sk-dummy"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: "emp-prov-1",
      modelId: "gemini-3.6-flash",
      displayName: "Gemini 3.6 Flash",
      enabled: true,
      createdAt: new Date(),
    });
    await db.insert(endpoints).values({
      id: "emp-ep-1",
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
      id: "emp-route-1",
      endpointId: "emp-ep-1",
      name: "Test Route",
      providerId: "emp-prov-1",
      providerProtocol: "openai",
      modelId: "gemini-3.6-flash",
      strategyRoutingEnabled: false,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: "emp-route-1",
      userId,
      createdAt: new Date(),
    });
  }

  it("recovers seamlessly when upstream returns 0-token empty output on turn 1 and valid output on turn 2", async () => {
    await setupEnvironment();

    let callCount = 0;
    const receivedBodies: any[] = [];

    const mockFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      callCount++;
      const body = JSON.parse(init.body);
      receivedBodies.push(body);

      if (callCount === 1) {
        // Turn 1: Empty 0-token response from upstream model
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            id: "chatcmpl-empty-1",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "gemini-3.6-flash",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 },
          }),
        };
      } else {
        // Turn 2: Recovered response after auto-injected continuation prompt
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            id: "chatcmpl-success-2",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "gemini-3.6-flash",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "export const getRecordList = () => {}" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 70, completion_tokens: 25, total_tokens: 95 },
          }),
        };
      }
    });

    vi.stubGlobal("fetch", mockFetch);

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gemini-3.6-flash",
        messages: [{ role: "user", content: "Generate API code" }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Verify client receives valid output
    expect(body.choices[0].message.content).toBe("export const getRecordList = () => {}");
    expect(callCount).toBe(2);

    // Verify turn 2 request had the injected continuation guard message
    expect(receivedBodies[1].messages.length).toBe(2);
    expect(receivedBodies[1].messages[1].role).toBe("user");
    expect(receivedBodies[1].messages[1].content).toContain("System Guard Note");
  });

  it("appends fallback notice when upstream repeatedly returns 0-token empty responses and exhausts retries", async () => {
    await setupEnvironment();

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          id: `chatcmpl-empty-${callCount}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gemini-3.6-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 },
        }),
      };
    });

    vi.stubGlobal("fetch", mockFetch);

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gemini-3.6-flash",
        messages: [{ role: "user", content: "Generate API code" }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Client should receive the fallback notice instead of a blank response
    expect(body.choices[0].message.content).toContain("模型响应结果为空 [0-Token]");
    // Initial call + 2 retries (maxRetries = 2) = 3 total attempts
    expect(callCount).toBe(3);
  });
});
