import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq, sql } from "drizzle-orm";

const testDbPath = "data/promptgate_test_capacity.sqlite";
process.env.DB_FILE = testDbPath;

let db: any;
let bootstrap: any;
let apiKeys: any;
let endpoints: any;
let endpointRoutes: any;
let providerApiKeys: any;
let providerModels: any;
let providers: any;
let systemSettings: any;
let users: any;
let gatewayRoutes: any;
let routeAuthorizations: any;
let encryptText: any;
let requestLogs: any;

const getResolvedDbPath = () => {
  if (process.cwd().endsWith("server")) {
    return path.join(process.cwd(), "../../", testDbPath);
  }
  return path.join(process.cwd(), testDbPath);
};

describe("Capacity Retry Integration Tests", () => {
  const fastify = Fastify();
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

    ({ db } = await import("../src/db"));
    ({ bootstrap } = await import("../src/bootstrap"));
    ({
      apiKeys,
      endpoints,
      endpointRoutes,
      providerApiKeys,
      providerModels,
      providers,
      systemSettings,
      users,
      routeAuthorizations,
      requestLogs,
    } = await import("../src/db/schema"));
    gatewayRoutes = (await import("../src/routes/gateway")).default;
    ({ encryptText } = await import("../src/utils/crypto"));

    const migrationsFolder = path.resolve(
      process.cwd(),
      process.cwd().endsWith("server") ? "./drizzle" : "apps/server/drizzle",
    );
    await migrate(db, { migrationsFolder });
    await bootstrap();

    // Configure system settings fallback
    await db.delete(systemSettings).where(eq(systemSettings.key, "allowUnknownHostFallback"));
    await db.insert(systemSettings).values({
      key: "allowUnknownHostFallback",
      value: "true",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    fastify.register(gatewayRoutes);
    await fastify.ready();

    userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: "capacity_user",
      passwordHash: "dummy",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rawKey = "pg_key_capacity_" + crypto.randomBytes(16).toString("hex");
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      userId: userId,
      name: "Capacity Integration Key",
      keyHash: keyHash,
      keyPrefix: rawKey.substring(0, 12),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    apiKey = rawKey;

    const provId = "openrouter-test-prov";
    await db.insert(providers).values({
      id: provId,
      name: "OpenRouter Test Provider",
      openaiBaseUrl: "https://openrouter.ai/api/v1",
      enabled: true,
      concurrencyLimit: 10,
      protocol: "openai",
      adapter: "openrouter",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(providerApiKeys).values({
      id: "or-cap-key-1",
      providerId: provId,
      keyEncrypted: encryptText("sk-or-cap-dummy-1"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });



    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: provId,
      modelId: "meta-llama/llama-3-8b-instruct",
      displayName: "Llama 3 8B",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(endpoints).values({
      id: "capacity-ep",
      userId: userId,
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(endpointRoutes).values({
      id: "capacity-route-1",
      name: "Capacity Route",
      endpointId: "capacity-ep",
      priority: 1,
      providerId: provId,
      providerProtocol: "openai",
      modelId: "meta-llama/llama-3-8b-instruct",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: "capacity-route-1",
      userId: userId,
      createdAt: new Date(),
    });
  });

  afterAll(async () => {
    await fastify.close();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should retry up to 2 times on openrouter provider_capacity_exhausted", async () => {
    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchCount++;
      if (fetchCount <= 2) {
        return new Response(JSON.stringify({
          error: { message: "ResourceExhausted: Provider capacity exhausted", code: 429, metadata: { provider_name: "OpenAI" } }
        }), {
          status: 429,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Date.now(),
        model: "meta-llama/llama-3-8b-instruct",
        choices: [{ index: 0, message: { role: "assistant", content: "Success!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      payload: {
        model: "meta-llama/llama-3-8b-instruct",
        messages: [{ role: "user", content: "Hello" }]
      }
    });

    expect(fetchCount).toBe(3);
    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body);
    expect(json.choices[0].message.content).toBe("Success!");

    // Check request logs
    const logs = await db.select().from(requestLogs).orderBy(sql`"createdAt" DESC`).limit(1);
    expect(logs[0].usageStatus).toBe("success");
  });
});
