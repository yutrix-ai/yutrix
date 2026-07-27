import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq, and, sql } from "drizzle-orm";

const testDbPath = "data/promptgate_test_keystate.sqlite";
process.env.DB_FILE = testDbPath;

let db: any;
let bootstrap: any;
let apiKeys: any;
let chatLogs: any;
let providerApiKeys: any;
let providerModels: any;
let providers: any;
let endpoints: any;
let endpointRoutes: any;
let users: any;
let gatewayRoutes: any;
let systemSettings: any;
let routeAuthorizations: any;
let encryptText: any;
let responseCache: any;
let actionLogs: any;
let subdomains: any;

const getResolvedDbPath = () => {
  if (process.cwd().endsWith("server")) {
    return path.join(process.cwd(), "../../", testDbPath);
  }
  return path.join(process.cwd(), testDbPath);
};

describe("Gateway 429 Key Rotation TDD", () => {
  const fastify = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  let apiKey = "";
  let userId = "";

  beforeAll(async () => {
    const resolvedPath = getResolvedDbPath();
    if (fs.existsSync(resolvedPath)) {
      try { fs.unlinkSync(resolvedPath); } catch (e) {}
    }
    if (fs.existsSync(resolvedPath + "-wal")) {
      try { fs.unlinkSync(resolvedPath + "-wal"); } catch (e) {}
    }
    if (fs.existsSync(resolvedPath + "-shm")) {
      try { fs.unlinkSync(resolvedPath + "-shm"); } catch (e) {}
    }

    ({ db } = await import("../src/db"));
    ({ bootstrap } = await import("../src/bootstrap"));
    ({
      apiKeys,
      chatLogs,
      endpoints,
      endpointRoutes,
      providerApiKeys,
      providerModels,
      providers,
      users,
      systemSettings,
      routeAuthorizations,
      responseCache,
      actionLogs,
      subdomains,
    } = await import("../src/db/schema"));
    ({ encryptText } = await import("../src/utils/crypto"));
    gatewayRoutes = (await import("../src/routes/gateway")).default;

    const migrationsFolder = path.resolve(
      process.cwd(),
      process.cwd().endsWith("server") ? "./drizzle" : "apps/server/drizzle",
    );
    await migrate(db, { migrationsFolder });
    await bootstrap();
    try {
      await db.run(sql`PRAGMA journal_mode=WAL`);
    } catch (e) {}

    await db.delete(systemSettings).where(eq(systemSettings.key, "allowUnknownHostFallback"));
    await db.insert(systemSettings).values({
      key: "allowUnknownHostFallback",
      value: "true",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    fastify.register(gatewayRoutes);
    await fastify.ready();

    await db.delete(users).where(eq(users.username, "tdduser"));

    userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: "tdduser",
      passwordHash: "dummy",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rawKey = "pg_key_tdd_" + crypto.randomBytes(16).toString("hex");
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      userId: userId,
      name: "TDD API Key",
      keyHash: keyHash,
      keyPrefix: rawKey.substring(0, 12),
      status: "active",
      concurrencyLimit: 10,
      createdAt: new Date(),
    });
    apiKey = rawKey;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (db && responseCache) {
      await db.delete(responseCache);
    }
  });

  afterAll(async () => {
    await fastify.close();
    const resolvedPath = getResolvedDbPath();
    if (fs.existsSync(resolvedPath)) {
      try { fs.unlinkSync(resolvedPath); } catch (e) {}
    }
  });

  describe("429 Key Rotation", () => {
    
    it("Case 1: Same Provider, different Model. Key A/B fails 401 on L1, Key A succeeds on L2", async () => {
      const provId = "prov-multi-model";
      const modelL1 = "model-kimi";
      const modelL2 = "model-qwen";
      
      await db.delete(providers).where(eq(providers.id, provId));
      await db.insert(providers).values({
        id: provId,
        name: "Test Provider",
        enabled: 1,
        concurrencyLimit: 10,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      
      await db.delete(providerModels).where(eq(providerModels.providerId, provId));
      await db.insert(providerModels).values([
        {
          id: provId + "-1",
          providerId: provId,
          modelId: modelL1,
          displayName: "Kimi",
          enabled: 1,
          active: 1,
          createdAt: new Date(),
        },
        {
          id: provId + "-2",
          providerId: provId,
          modelId: modelL2,
          displayName: "Qwen",
          enabled: 1,
          active: 1,
          createdAt: new Date(),
        }
      ]);
      
      await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, provId));
      await db.insert(providerApiKeys).values([
        {
          id: provId + "-keyA",
          providerId: provId,
          keyEncrypted: encryptText("tokenA"),
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: provId + "-keyB",
          providerId: provId,
          keyEncrypted: encryptText("tokenB"),
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      ]);

      const endpointId = "ep-multi-model";
      await db.delete(endpoints).where(eq(endpoints.id, endpointId));
      await db.insert(endpoints).values({
        id: endpointId,
        userId,
        name: "Test Endpoint",
        path: "/v1/chat/completions",
        protocol: "openai",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      
      const routeId = crypto.randomUUID();
      const targets = [
        {
          providerId: provId,
          modelId: modelL1,
          strategyRoutingEnabled: false,
        },
        {
          providerId: provId,
          modelId: modelL2,
          strategyRoutingEnabled: false,
        }
      ];

      await db.insert(endpointRoutes).values({
        id: routeId,
        endpointId,
        routeName: "route-multi",
        modelId: "any",
        providerId: "any",
        retryCount: 0,
        fallbackEnabled: true,
        strategyRoutingEnabled: false,
        targets: JSON.stringify(targets),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      
      await db.insert(routeAuthorizations).values({
        id: crypto.randomUUID(),
        routeId: routeId,
        userId: userId,
        createdAt: new Date(),
      });

      let fetchCount = 0;
      let usedTokens = [];
      const mockFetch = vi.fn().mockImplementation(async (url, options) => {
        fetchCount++;
        const auth = options.headers?.Authorization || options.headers?.get?.("authorization") || "";
        usedTokens.push(auth);
        
        // Check which model the payload implies (we can check the URL or body)
        const body = JSON.parse(options.body);
        if (body.model === modelL1) {
          // Both keys fail on L1 with 401
          return new Response(JSON.stringify({
            error: { type: "api_error", message: "invalid access token", code: "invalid_api_key" }
          }), { status: 401, headers: { "content-type": "application/json" } });
        } else if (body.model === modelL2) {
          // Success on L2
          return new Response(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: modelL2,
            choices: [{
              index: 0,
              message: { role: "assistant", content: "Success from L2" },
              finish_reason: "stop"
            }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("Error", { status: 500 });
      });
      global.fetch = mockFetch;

      const response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        payload: {
          model: "any",
          messages: [{ role: "user", content: "hello" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchCount).toBe(3); // 2 fails on L1, 1 success on L2
      
      const resBody = JSON.parse(response.body);
      expect(resBody.choices[0].message.content).toBe("Success from L2");
      
      const dbKeys = await db.select().from(providerApiKeys).where(eq(providerApiKeys.providerId, provId));
      expect(dbKeys.length).toBe(2);
      expect(dbKeys[0].status).toBe("active");
      expect(dbKeys[1].status).toBe("active");
      
      // Ensure Key A was reused on L2
      const uniqueAuths = new Set(usedTokens);
      expect(uniqueAuths.size).toBe(2);
    });

    it("Case 2: Capacity Error -> 429 mix, with preferredKey loop prevention", async () => {
      const provId = "prov-cap-error";
      const modelId = "model-cap";
      
      await db.delete(providers).where(eq(providers.id, provId));
      await db.insert(providers).values({
        id: provId,
        name: provId, // OpenRouter like
        openaiBaseUrl: "https://openrouter.ai/api/v1",
        enabled: 1,
        concurrencyLimit: 10,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      
      await db.delete(providerModels).where(eq(providerModels.providerId, provId));
      await db.insert(providerModels).values({
        id: provId + "-1",
        providerId: provId,
        modelId,
        displayName: "Nemotron",
        enabled: 1,
        active: 1,
        createdAt: new Date(),
      });
      
      await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, provId));
      await db.insert(providerApiKeys).values([
        {
          id: provId + "-keyA",
          providerId: provId,
          keyEncrypted: encryptText("tokenA"),
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: provId + "-keyB",
          providerId: provId,
          keyEncrypted: encryptText("tokenB"),
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      ]);

      const endpointId = "ep-cap";
      await db.delete(endpoints).where(eq(endpoints.id, "ep-multi-model"));
      await db.delete(endpoints).where(eq(endpoints.id, endpointId));
      await db.insert(endpoints).values({
        id: endpointId,
        userId,
        name: "Cap Endpoint",
        path: "/v1/chat/completions",
        protocol: "openai",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      
      const routeId = crypto.randomUUID();
      const targets = [
        {
          providerId: provId,
          modelId: modelId,
          strategyRoutingEnabled: false,
        }
      ];

      const subId = "sub-cap";
      await db.insert(subdomains).values({
        id: subId,
        userId,
        name: "Cap Sub",
        hostname: "cap-host.promptgate.local",
        enabled: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).onConflictDoNothing();
      
      await db.insert(endpointRoutes).values({
        id: routeId,
        endpointId,
        subdomainId: subId,
        routeName: "route-cap",
        modelId: "any",
        providerId: "any",
        retryCount: 0,
        fallbackEnabled: false,
        strategyRoutingEnabled: false,
        targets: JSON.stringify(targets),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      
      await db.insert(routeAuthorizations).values({
        id: crypto.randomUUID(),
        routeId: routeId,
        userId: userId,
        createdAt: new Date(),
      });

      let fetchCount = 0;
      let tokensUsed = [];
      const mockFetch = vi.fn().mockImplementation(async (url, options) => {
        fetchCount++;
        const auth = options.headers?.Authorization || options.headers?.get?.("authorization") || "";
        tokensUsed.push(auth);
        
        if (fetchCount === 1) {
          // OpenRouter capacity error format
          return new Response(JSON.stringify({
             error: {
                 message: "Upstream error from Nvidia:\nResourceExhausted:\nWorker local total request limit reached (79/32)",
                 code: 429,
                 metadata: { provider_name: "Nvidia" }
             }
          }), { status: 429, headers: { "content-type": "application/json" } }); 
        } else if (fetchCount === 2) {
          return new Response(JSON.stringify({ error: { message: "rate limit"} }), { status: 429, headers: { "content-type": "application/json" } });
        } else {
          return new Response(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{
              index: 0,
              message: { role: "assistant", content: "Success" },
              finish_reason: "stop"
            }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
      });
      global.fetch = mockFetch;

      const response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "host": "cap-host.promptgate.local",
        },
        payload: {
          model: modelId,
          messages: [{ role: "user", content: "hello" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchCount).toBe(3);
      
      const expectedA = "Bearer tokenA";
      const expectedB = "Bearer tokenB";
      
      // Since order of keys selected first is non-deterministic (randomized in selectProviderKey initially),
      // we just want to ensure it did X, X, Y
      expect(tokensUsed[0]).toBe(tokensUsed[1]);
      expect(tokensUsed[2]).not.toBe(tokensUsed[0]);
      expect([expectedA, expectedB]).toContain(tokensUsed[2]);
    });

});
});
