import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq, like } from "drizzle-orm";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";

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
let encryptText: any;

const dbFile = "data/promptgate-test-effective-url.sqlite";

describe("OpenRouter Effective Base URL", () => {
  const fastify = Fastify();
  let apiKey = "";
  let userId = "";
  let savedDbFile: string | undefined;

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
    } = await import("../src/db/schema"));
    gatewayRoutes = (await import("../src/routes/gateway")).default;
    ({ encryptText } = await import("../src/utils/crypto"));

    fastify.register(gatewayRoutes);
    await fastify.ready();

    await db.delete(systemSettings).where(eq(systemSettings.key, "allowUnknownHostFallback"));
    await db.insert(systemSettings).values({
      key: "allowUnknownHostFallback",
      value: "true",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    userId = crypto.randomUUID();
    const uniqueSuffix = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: "or_url_user_" + uniqueSuffix,
      passwordHash: "dummy",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rawKey = "pg_key_or_url_" + crypto.randomBytes(16).toString("hex");
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      userId: userId,
      name: "OR URL Key",
      keyHash: keyHash,
      keyPrefix: rawKey.substring(0, 12),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    apiKey = rawKey;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();

    if (db && userId) {
      try {
        await db.delete(routeAuthorizations).where(eq(routeAuthorizations.userId, userId));
        await db.delete(endpointRoutes).where(like(endpointRoutes.providerId, "prov%"));
        await db.delete(endpoints).where(eq(endpoints.userId, userId));
        await db.delete(providerModels).where(like(providerModels.providerId, "prov%"));
        await db.delete(providerApiKeys).where(like(providerApiKeys.providerId, "prov%"));
        await db.delete(providers).where(like(providers.id, "prov%"));
        await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
        await db.delete(users).where(eq(users.id, userId));
      } catch (e) {
        console.error("Cleanup error:", e);
      }
    }

    await fastify.close();
    await closeAndCleanup(client, dbFile);

    if (savedDbFile !== undefined) {
      process.env.DB_FILE = savedDbFile;
    } else {
      delete process.env.DB_FILE;
    }
  });

  it("providerProtocol=anthropic, only openaiBaseUrl=OpenRouter, incomingProtocol=anthropic", async () => {
    const provId = "prov1-" + crypto.randomUUID();
    await db.insert(providers).values({
      id: provId,
      name: "OpenRouter Anthropic Provider",
      openaiBaseUrl: "https://openrouter.ai/api/v1",
      anthropicBaseUrl: null, // no anthropicBaseUrl
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(providerApiKeys).values({
      id: "key1-" + crypto.randomUUID(),
      providerId: provId,
      keyEncrypted: encryptText("sk-or-dummy-key"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: provId,
      modelId: "anthropic/claude-3.5-sonnet",
      displayName: "claude-3.5-sonnet",
      enabled: true,
      createdAt: new Date(),
    });

    const epId = "ep1-" + crypto.randomUUID();
    await db.insert(endpoints).values({
      id: epId,
      userId: userId,
      name: "Anthropic Endpoint",
      path: "/v1/messages",
      incomingProtocol: "anthropic",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const routeId = "route1-" + crypto.randomUUID();
    await db.insert(endpointRoutes).values({
      id: routeId,
      endpointId: epId,
      name: "Anthropic Route",
      providerId: provId,
      providerProtocol: "anthropic", // providerProtocol = "anthropic"
      modelId: "anthropic/claude-3.5-sonnet",
      strategyRoutingEnabled: false,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: routeId,
      userId: userId,
      createdAt: new Date(),
    });

    let fetchedUrl = "";
    let fetchedHeaders: Record<string, string> = {};
    let fetchedBody: any = null;

    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchedUrl = url;
      fetchedHeaders = (init?.headers || {}) as Record<string, string>;
      fetchedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello from OR" }],
          model: "anthropic/claude-3.5-sonnet",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 10 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      payload: {
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10
      }
    });

    expect(response.statusCode).toBe(200);
    expect(fetchedUrl).toBe("https://openrouter.ai/api/v1/messages");
    expect(fetchedHeaders["authorization"]).toBe("Bearer sk-or-dummy-key");
    expect(fetchedHeaders["x-api-key"]).toBeUndefined();
    expect(fetchedUrl).not.toContain("api.anthropic.com");
    expect(fetchedBody.messages).toBeDefined();
    expect(fetchedBody.model).toBe("anthropic/claude-3.5-sonnet");
  });
});
