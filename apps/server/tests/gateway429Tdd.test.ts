import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq, and, sql } from "drizzle-orm";

const testDbPath = "data/promptgate_test_gateway429.sqlite";
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
    it("Case A: A provider has two keys, both return 429, no fallback -> returns 429, fetchCount=2", async () => {
      const provId = "prov-429-double";
      const modelId = "model-429-double";

      await db.delete(providers).where(eq(providers.id, provId));
      await db.insert(providers).values({
        id: provId,
        name: provId,
        enabled: true,
        openaiBaseUrl: "https://api.double429.ai/v1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, provId));
      await db.insert(providerApiKeys).values([
        {
          id: "key-429-1",
          providerId: provId,
          keyEncrypted: encryptText("secret-1"),
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "key-429-2",
          providerId: provId,
          keyEncrypted: encryptText("secret-2"),
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      ]);
      await db.delete(providerModels).where(eq(providerModels.providerId, provId));
      await db.insert(providerModels).values({
        id: crypto.randomUUID(),
        providerId: provId,
        modelId: modelId,
        displayName: "Double 429 Model",
        enabled: true,
        active: true,
        createdAt: new Date(),
      });

      const epId = "ep-429-double";
      await db.delete(endpoints).where(eq(endpoints.id, epId));
      await db.insert(endpoints).values({
        id: epId,
        userId: userId,
        name: "gateway",
        path: "/v1/chat/completions",
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

      await db.insert(endpointRoutes).values({
        id: routeId,
        endpointId: epId,
        routeName: "route-429-double",
        modelId: modelId,
        providerId: provId,
        retryCount: 0,
        fallbackEnabled: false,
        strategyRoutingEnabled: true,
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
      let usedAuths = new Set<string>();
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        fetchCount++;
        const hdrs = new Headers(init?.headers);
        const authHeader = hdrs.get("authorization");
        if (authHeader) usedAuths.add(authHeader);
        return new Response(JSON.stringify({ error: "rate limit" }), { status: 429, headers: { "content-type": "application/json" } });
      });

      const response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { model: modelId, messages: [{ role: "user", content: "test" }], stream: false },
      });

      expect(fetchCount).toBe(2);
      expect(usedAuths.size).toBe(2);
      expect(response.statusCode).toBe(429); // MUST not be 500
      const resBody = JSON.parse(response.body);
      expect(resBody.error.message).toBe("rate limit");

      const keysInDb = await db.select().from(providerApiKeys).where(eq(providerApiKeys.providerId, provId));
      expect(keysInDb.find((k: any) => k.id === "key-429-1")?.status).toBe("active");
      expect(keysInDb.find((k: any) => k.id === "key-429-2")?.status).toBe("active");
    });
  });
});
