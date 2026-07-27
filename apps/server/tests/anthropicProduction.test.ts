import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { eq } from "drizzle-orm";

const testDbPath = "data/promptgate_test_anthropic.sqlite";
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
let promptPolicies: any;
let routeAuthorizations: any;

let fastifyApp: any;
let gatewayRoutes: any;

describe("Anthropic Production Integration Tests", () => {
  let userId: string;
  let apiKey: string;
  const provId = "openrouter-anthropic-prov";
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
      endpoints,
      providerModels,
      providers,
      endpointRoutes,
      providerApiKeys,
      apiKeys,
      systemSettings,
      users,
      promptPolicies,
      routeAuthorizations
    } = await import("../src/db/schema"));

    await bootstrap();

    userId = crypto.randomUUID();
    apiKey = "pg_key_anthropic";

    await db.insert(users).values({
      id: userId,
      username: "anthropic_user_" + crypto.randomUUID(),
      passwordHash: "dummy",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.delete(systemSettings).where(eq(systemSettings.key, "allowUnknownHostFallback"));
    await db.insert(systemSettings).values({
      key: "allowUnknownHostFallback",
      value: "true",
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      userId: userId,
      name: "Anthropic Integration Key",
      keyHash: crypto.createHash("sha256").update(apiKey).digest("hex"),
      keyPrefix: apiKey,
      status: "active",
      concurrencyLimit: 2,
      createdAt: new Date(),
    });

    await db.delete(providers).where(eq(providers.id, provId));
    await db.insert(providers).values({
      id: provId,
      name: "OpenRouter Anthropic Provider",
      openaiBaseUrl: "https://openrouter.ai/api/v1",
      anthropicBaseUrl: "https://api.anthropic.com/v1",
      protocol: "openai",
      concurrencyLimit: 10,
      timeoutMs: 60000,
      streamTimeoutMs: 180000,
      maxOutputTokens: 0,
      hourlyTokenLimit: 0,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { encryptText } = await import("../src/utils/crypto");

    await db.insert(providerApiKeys).values({
      id: "or-anthropic-key-1",
      providerId: provId,
      keyEncrypted: await encryptText("dummy_secret"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(providerModels).values([
      {
        id: crypto.randomUUID(),
        providerId: provId,
        modelId: "anthropic/claude-3-haiku",
        displayName: "Claude 3 Haiku",
        enabled: true,
        active: true,
        createdAt: new Date(),
      },
      {
        id: crypto.randomUUID(),
        providerId: provId,
        modelId: "anthropic/claude-3-opus",
        displayName: "Claude 3 Opus",
        enabled: true,
        active: true,
        createdAt: new Date(),
      }
    ]);

    await db.insert(endpoints).values({
      id: "anthropic-ep",
      userId: "",
      path: "/v1/messages",
      incomingProtocol: "anthropic",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(endpointRoutes).values({
      id: "anthropic-route-1",
      name: "Anthropic Route",
      endpointId: "anthropic-ep",
      priority: 1,
      providerId: provId,
      providerProtocol: "openai",
      modelId: "anthropic/claude-3-haiku",
      targetType: "multi",
      targets: JSON.stringify([
        { providerId: provId, providerProtocol: "openai", modelId: "anthropic/claude-3-haiku", strategyRoutingEnabled: false, strategyRoutingRules: "[]", weight: 100 },
        { providerId: provId, providerProtocol: "openai", modelId: "anthropic/claude-3-opus", strategyRoutingEnabled: true, strategyRoutingRules: JSON.stringify([{taskType: "vision", enabled: true, providerId: provId, providerProtocol: "openai", modelId: "anthropic/claude-3-opus"}]), weight: 100 }
      ]),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: "anthropic-route-1",
      userId: userId,
      createdAt: new Date(),
    });

    gatewayRoutes = (await import("../src/routes/gateway")).default;
    fastifyApp = Fastify();
    fastifyApp.register(gatewayRoutes);
    await fastifyApp.ready();
  });

  afterAll(async () => {
    if (fastifyApp) {
      await fastifyApp.close();
    }
    const resolvedPath = getResolvedDbPath();
    if (fs.existsSync(resolvedPath)) {
      try { fs.unlinkSync(resolvedPath); } catch (e) {}
    }
    if (fs.existsSync(resolvedPath + "-wal")) {
      try { fs.unlinkSync(resolvedPath + "-wal"); } catch (e) {}
    }
  });

  it("handles anthropic vision requests and routes correctly", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, options: any) => {
      const reqBody = JSON.parse(options.body);
      const isVision = reqBody.messages?.some((m: any) => 
        Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image')
      );
      
      if (reqBody.model === "anthropic/claude-3-haiku") {
        if (isVision) {
          return new Response(JSON.stringify({
            error: {
              message: "No endpoints found that support image input",
              code: 400,
              metadata: { provider_name: "OpenAI" }
            }
          }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
      }

      if (reqBody.model === "anthropic/claude-3-opus") {
        return new Response(JSON.stringify({
          id: "msg_mock",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Success from Opus!" }],
          model: "anthropic/claude-3-opus",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 15, output_tokens: 5 }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response("Not found", { status: 404 });
    });

    const response = await fastifyApp.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "X-Endpoint-Id": "anthropic-ep"
      },
      payload: {
        model: "claude-3-haiku-20240307",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "mockdata" } }
            ]
          }
        ],
        max_tokens: 100
      }
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body);
    // OpenRouter adapter with openai protocol returns OpenAI format!
    // Wait, the client is sending /v1/messages (Anthropic incoming protocol), so the gateway responds in Anthropic format!
    expect(json.content[0].text).toBe("Success from Opus!");
    expect(json.model).toBe("anthropic/claude-3-opus");
  });
});
