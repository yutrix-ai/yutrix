import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq, sql } from "drizzle-orm";

const testDbPath = "data/promptgate_test_vision.sqlite";
process.env.DB_FILE = testDbPath;

let db: any;
let bootstrap: any;
let endpoints: any;
let providerModels: any;
let providers: any;
let endpointRoutes: any;
let providerApiKeys: any;
let apiKeys: any;
let systemSettings: any;
let users: any;
let gatewayRoutes: any;
let routeAuthorizations: any;
let encryptText: any;
let requestLogs: any;

const fastify = Fastify();

describe("Vision Fallback Integration Tests", () => {
  let userId: string;
  let apiKey: string;
  const provId = "openrouter-vision-prov";
  const getResolvedDbPath = () => {
    if (process.cwd().endsWith("server")) {
      return path.join(process.cwd(), "../../", testDbPath);
    }
    return path.join(process.cwd(), testDbPath);
  };

  beforeAll(async () => {
    const resolvedPath = getResolvedDbPath();
    if (fs.existsSync(resolvedPath)) {
      try { fs.unlinkSync(resolvedPath); } catch (e) {}
    }
    if (fs.existsSync(resolvedPath + "-wal")) {
      try { fs.unlinkSync(resolvedPath + "-wal"); } catch (e) {}
    }

    db = (await import("../src/db")).db;
    bootstrap = (await import("../src/bootstrap")).bootstrap;
    ({
      apiKeys,
      endpointRoutes,
      endpoints,
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

    // Create a test user if not exists
    userId = crypto.randomUUID();
    const uniqueSuffix = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: `vision_user_${uniqueSuffix}`,
      passwordHash: "dummy",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const apiKeyId = crypto.randomUUID();
    apiKey = "pg_key_vision_" + crypto.randomUUID();
    const keyHashHex = crypto.createHash("sha256").update(apiKey).digest("hex");

    await db.insert(apiKeys).values({
      id: apiKeyId,
      userId: userId,
      name: "Vision Integration Key",
      keyHash: keyHashHex,
      keyPrefix: "pg_key_vision",
      concurrencyLimit: 2,
      status: "active",
      createdAt: new Date(),
    });

    await db.insert(providers).values({
      id: provId,
      name: "OpenRouter Vision Provider",
      openaiBaseUrl: "https://openrouter.ai/api/v1",
      enabled: true,
      concurrencyLimit: 10,
      timeoutMs: 60000,
      streamTimeoutMs: 180000,
      hourlyTokenLimit: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(providerApiKeys).values({
      id: "or-vision-key-1",
      providerId: provId,
      keyEncrypted: encryptText("sk-or-vision-dummy"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });


    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: provId,
      modelId: "vision-model-2",
      displayName: "Vision Model 2",
      enabled: true,
      active: true,
      createdAt: new Date(),
    });

    await db.insert(endpoints).values({
      id: "vision-ep",
      userId: userId,
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(endpoints).values({
      id: "vision-ep-anthropic",
      userId: userId,
      path: "/v1/messages",
      incomingProtocol: "anthropic",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const strategyRoutingRulesTarget2 = [
      { providerId: provId, providerProtocol: "openai", modelId: "vision-model-2", taskType: "vision", enabled: true }
    ];

    await db.insert(endpointRoutes).values({
      id: "vision-route-1",
      name: "Vision Route",
      endpointId: "vision-ep",
      priority: 1,
      providerId: provId,
      providerProtocol: "openai",
      modelId: "meta-llama/llama-3-8b-instruct",
      targetType: "multi",
      targets: JSON.stringify([
        { providerId: provId, providerProtocol: "openai", modelId: "meta-llama/llama-3-8b-instruct", strategyRoutingEnabled: false, strategyRoutingRules: "[]", weight: 100 },
        { providerId: provId, providerProtocol: "openai", modelId: "vision-model-2", strategyRoutingEnabled: true, strategyRoutingRules: JSON.stringify(strategyRoutingRulesTarget2), weight: 100 }
      ]),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(endpointRoutes).values({
      id: "vision-route-anthropic",
      name: "Vision Route Anthropic",
      endpointId: "vision-ep-anthropic",
      priority: 1,
      providerId: provId,
      providerProtocol: "anthropic",
      modelId: "meta-llama/llama-3-8b-instruct",
      targetType: "multi",
      targets: JSON.stringify([]),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: "vision-route-1",
      userId: userId,
      createdAt: new Date(),
    });
    await db.insert(routeAuthorizations).values({
      id: "vision-route-anthropic-auth",
      routeId: "vision-route-anthropic",
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

  it("L1 vision 404 image unsupported falls back to L2 vision", async () => {
    let fetchCount = 0;
    let requests: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchCount++;
      const reqBody = JSON.parse(String(init?.body || "{}"));
      requests.push(reqBody);

      if (reqBody.model === "meta-llama/llama-3-8b-instruct") {
        return new Response(JSON.stringify({
          error: {
            message: "No endpoints found that support image input",
            code: 400,
            metadata: { provider_name: "OpenAI" }
          }
        }), { status: 400, headers: { "Content-Type": "application/json" } });
      }

      if (reqBody.model === "vision-model-2") {
        return new Response(JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Date.now(),
          model: "vision-model-2",
          choices: [{ index: 0, message: { role: "assistant", content: "Success!" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      return new Response("Not found", { status: 404 });
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
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "image_url", image_url: { url: "data:image/jpeg;base64,mock" } }
            ]
          }
        ]
      }
    });

    expect(fetchCount).toBe(1);
    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body);
    expect(json.choices[0].message.content).toBe("Success!");
    
    expect(requests[0].model).toBe("vision-model-2");

    // Check request logs
    const logs = await db.select().from(requestLogs).orderBy(sql`"createdAt" DESC`).limit(1);
    expect(logs[0].usageStatus).toBe("success");
  });

  it("A. L1 has Vision: First fetch is L1 Vision, fetchCount=1", async () => {
    let fetchCount = 0;
    let requests: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchCount++;
      const reqBody = JSON.parse(String(init?.body || "{}"));
      requests.push(reqBody);

      if (reqBody.model === "vision-model-1") {
        return new Response(JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Date.now(),
          model: "vision-model-1",
          choices: [{ index: 0, message: { role: "assistant", content: "Success L1 Vision!" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("Not found", { status: 404 });
    });

    // We need to modify route targets to have L1 vision for this test
    await db.update(endpointRoutes).set({
      targets: JSON.stringify([
        { providerId: provId, providerProtocol: "openai", modelId: "vision-model-1", strategyRoutingEnabled: true, strategyRoutingRules: JSON.stringify([
          { providerId: provId, providerProtocol: "openai", modelId: "vision-model-1", taskType: "vision", enabled: true }
        ]), weight: 100 }
      ])
    , fallbackEnabled: 3 }).where(eq(endpointRoutes.id, "vision-route-1"));

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      payload: {
        model: "meta-llama/llama-3-8b-instruct",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,mock" } }] }
        ]
      }
    });

    expect(fetchCount).toBe(1);
    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body);
    expect(json.choices[0].message.content).toBe("Success L1 Vision!");
    expect(requests[0].model).toBe("vision-model-1");
  });

  it("C. All layers have no Vision: fetchCount=0, returns vision_routing_unavailable", async () => {
    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchCount++;
      return new Response("Not found", { status: 404 });
    });

    await db.update(endpointRoutes).set({
      targets: JSON.stringify([
        { providerId: provId, providerProtocol: "openai", modelId: "meta-llama/llama-3-8b-instruct", strategyRoutingEnabled: false, strategyRoutingRules: "[]", weight: 100 }
      ])
    , fallbackEnabled: 3 }).where(eq(endpointRoutes.id, "vision-route-1"));

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: {
        model: "meta-llama/llama-3-8b-instruct",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,mock" } }] }
        ]
      }
    });

    expect(fetchCount).toBe(0);
    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.body);
    expect(json.error.code).toBe("vision_routing_unavailable");
  });

  it("E. Classic routing bypasses vision guard and forwards image requests to layer model", async () => {
    let fetchCount = 0;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      fetchCount++;
      const reqBody = JSON.parse(String(init?.body || "{}"));
      expect(reqBody.model).toBe("meta-llama/llama-3-8b-instruct");
      return new Response(
        JSON.stringify({
          error: { message: "model does not support images", type: "invalid_request_error" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    });

    await db.update(endpointRoutes).set({
      routingMode: "classic",
      targets: JSON.stringify([
        {
          providerId: provId,
          providerProtocol: "openai",
          modelId: "meta-llama/llama-3-8b-instruct",
          strategyRoutingEnabled: false,
          strategyRoutingRules: [],
          weight: 100,
        },
      ]),
      fallbackEnabled: 0,
    }).where(eq(endpointRoutes.id, "vision-route-1"));

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: {
        model: "meta-llama/llama-3-8b-instruct",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "image_url", image_url: { url: "data:image/jpeg;base64,mock" } },
            ],
          },
        ],
      },
    });

    expect(fetchCount).toBe(1);
    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.body);
    expect(json.error?.code).not.toBe("vision_routing_unavailable");
  });

  it("D. L1 Vision returns 404, fallback to L2 Vision", async () => {
    let fetchCount = 0;
    let requests: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchCount++;
      const reqBody = JSON.parse(String(init?.body || "{}"));
      requests.push(reqBody);

      if (reqBody.model === "vision-model-1") {
        return new Response(JSON.stringify({
          error: { message: "No endpoints found that support image input", code: 400, metadata: { provider_name: "OpenAI" } }
        }), { status: 400, headers: { "Content-Type": "application/json" } });
      }

      if (reqBody.model === "vision-model-2") {
        return new Response(JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Date.now(),
          model: "vision-model-2",
          choices: [{ index: 0, message: { role: "assistant", content: "Success L2 Vision!" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await db.update(endpointRoutes).set({
      targets: JSON.stringify([
        { providerId: provId, providerProtocol: "openai", modelId: "vision-model-1", strategyRoutingEnabled: true, strategyRoutingRules: JSON.stringify([
          { providerId: provId, providerProtocol: "openai", modelId: "vision-model-1", taskType: "vision", enabled: true }
        ]), weight: 100, retryCount: 0 },
        { providerId: provId, providerProtocol: "openai", modelId: "vision-model-2", strategyRoutingEnabled: true, strategyRoutingRules: JSON.stringify([
          { providerId: provId, providerProtocol: "openai", modelId: "vision-model-2", taskType: "vision", enabled: true }
        ]), weight: 100, retryCount: 0 }
      ])
    , fallbackEnabled: 3 }).where(eq(endpointRoutes.id, "vision-route-1"));

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: {
        model: "meta-llama/llama-3-8b-instruct",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,mock" } }] }]
      }
    });

    expect(fetchCount).toBe(2);
    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body);
    expect(json.choices[0].message.content).toBe("Success L2 Vision!");
    expect(requests[0].model).toBe("vision-model-1");
    expect(requests[1].model).toBe("vision-model-2");
  });

  it("Real /v1/messages history image test", async () => {
    let fetchCount = 0;
    let requests: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchCount++;
      const reqBody = JSON.parse(String(init?.body || "{}"));
      requests.push(reqBody);
      return new Response(JSON.stringify({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Success History Image!" }],
        model: "vision-model-1",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await db.update(endpointRoutes).set({
      targets: JSON.stringify([
        { providerId: provId, providerProtocol: "anthropic", modelId: "meta-llama/llama-3-8b-instruct", strategyRoutingEnabled: false, strategyRoutingRules: "[]", weight: 100 },
        { providerId: provId, providerProtocol: "anthropic", modelId: "vision-model-1", strategyRoutingEnabled: true, strategyRoutingRules: JSON.stringify([
          { providerId: provId, providerProtocol: "anthropic", modelId: "vision-model-1", taskType: "vision", enabled: true }
        ]), weight: 100 }
      ])
    }).where(eq(endpointRoutes.id, "vision-route-anthropic"));

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      payload: {
        model: "meta-llama/llama-3-8b-instruct",
        messages: [
          { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "mock" } }] },
          { role: "assistant", content: "hello" },
          { role: "user", content: "continue" }
        ],
        max_tokens: 100
      }
    });

    expect(fetchCount).toBe(1);
    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body);
    expect(json.content[0].text).toBe("Success History Image!");
    expect(requests[0].model).toBe("vision-model-1");
  });

});
