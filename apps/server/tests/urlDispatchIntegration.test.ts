import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq, like } from "drizzle-orm";
import { encryptText } from "../src/utils/crypto";
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

const dbFile = "data/promptgate-test-urldispatch.sqlite";

describe("URL Dispatch Integration", () => {
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
      username: "testuser",
      passwordHash: "dummy",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rawKey = "pg_key_urld_" + crypto.randomUUID().slice(0, 8);
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
  });

  afterAll(async () => {
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
    if (db) {
      try {
        await db.delete(routeAuthorizations).where(like(routeAuthorizations.routeId, "urld-%"));
        await db.delete(endpointRoutes).where(like(endpointRoutes.id, "urld-%"));
        await db.delete(endpoints).where(like(endpoints.id, "urld-%"));
        await db.delete(providerModels).where(like(providerModels.providerId, "urld-%"));
        await db.delete(providerApiKeys).where(like(providerApiKeys.providerId, "urld-%"));
        await db.delete(providers).where(like(providers.id, "urld-%"));
      } catch (e) {
        console.error("Cleanup error:", e);
      }
    }
    delete process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS;
  });

  async function setupProvider(opts: {
    provId: string;
    name: string;
    openaiBaseUrl?: string | null;
    anthropicBaseUrl?: string | null;
  }) {
    await db.insert(providers).values({
      id: opts.provId,
      name: opts.name,
      openaiBaseUrl: opts.openaiBaseUrl,
      anthropicBaseUrl: opts.anthropicBaseUrl,
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerApiKeys).values({
      id: opts.provId + "-key",
      providerId: opts.provId,
      keyEncrypted: encryptText("sk-dummy"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: opts.provId,
      modelId: "test-model",
      displayName: "Test Model",
      enabled: true,
      createdAt: new Date(),
    });
  }

  async function setupEndpointRoute(opts: {
    epId: string;
    routeId: string;
    provId: string;
    incomingProtocol: string;
    providerProtocol: string;
    priority?: number;
  }) {
    await db.insert(endpoints).values({
      id: opts.epId,
      userId: userId,
      name: "Test Endpoint",
      path: opts.incomingProtocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions",
      incomingProtocol: opts.incomingProtocol,
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(endpointRoutes).values({
      id: opts.routeId,
      endpointId: opts.epId,
      name: "Test Route",
      providerId: opts.provId,
      providerProtocol: opts.providerProtocol,
      modelId: "test-model",
      strategyRoutingEnabled: false,
      status: "active",
      priority: opts.priority || 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: opts.routeId,
      userId,
      createdAt: new Date(),
    });
  }

  function mockFetchReturning(statusCode = 200) {
    let fetchedUrl = "";
    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchedUrl = url;
      fetchCount++;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
        { status: statusCode, headers: { "content-type": "application/json" } },
      );
    });
    return { getUrl: () => fetchedUrl, getCount: () => fetchCount };
  }

  it("A: providerProtocol=anthropic, anthropicBaseUrl=null, openaiBaseUrl=OpenRouter, disabled=openrouter", async () => {
    process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = "openrouter";
    await setupProvider({
      provId: "urld-prov-A",
      name: "Disabled OpenRouter Anthropic",
      anthropicBaseUrl: null,
      openaiBaseUrl: "https://openrouter.ai/api/v1",
    });
    await setupEndpointRoute({
      epId: "urld-ep-A",
      routeId: "urld-route-A",
      provId: "urld-prov-A",
      incomingProtocol: "openai",
      providerProtocol: "anthropic",
    });

    const mock = mockFetchReturning(200);
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    });

    expect(response.statusCode).toBe(200);
    expect(mock.getUrl()).toContain("openrouter.ai");
    expect(mock.getUrl()).not.toContain("api.anthropic.com");
    expect(mock.getCount()).toBe(1);
  });

  it("B: providerProtocol=openai, openaiBaseUrl=null, anthropicBaseUrl=OpenRouter, disabled=openrouter", async () => {
    process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = "openrouter";
    await setupProvider({
      provId: "urld-prov-B",
      name: "Disabled OpenRouter OpenAI",
      openaiBaseUrl: null,
      anthropicBaseUrl: "https://openrouter.ai/api/v1",
    });
    await setupEndpointRoute({
      epId: "urld-ep-B",
      routeId: "urld-route-B",
      provId: "urld-prov-B",
      incomingProtocol: "openai",
      providerProtocol: "openai",
    });

    const mock = mockFetchReturning(200);
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    });

    expect(response.statusCode).toBe(200);
    expect(mock.getUrl()).toContain("openrouter.ai");
    expect(mock.getUrl()).not.toContain("api.openai.com");
    expect(mock.getCount()).toBe(1);
  });

  it("C: primary OpenRouter + disabled + secondary Google -> continues to assert primary OpenRouter URL", async () => {
    process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = "openrouter";
    await setupProvider({
      provId: "urld-prov-C",
      name: "Disabled OpenRouter with Google Secondary",
      openaiBaseUrl: "https://openrouter.ai/api/v1",
      anthropicBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
    await setupEndpointRoute({
      epId: "urld-ep-C",
      routeId: "urld-route-C",
      provId: "urld-prov-C",
      incomingProtocol: "openai",
      providerProtocol: "openai",
    });

    const mock = mockFetchReturning(200);
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    });

    expect(response.statusCode).toBe(200);
    expect(mock.getUrl()).toContain("openrouter.ai");
    expect(mock.getUrl()).not.toContain("googleapis.com");
  });

  describe("Alternate URL rules (Section 三 requirements)", () => {
    it("Scenario A: providerProtocol=anthropic, anthropicBaseUrl=null, openaiBaseUrl=Alibaba", async () => {
      await setupProvider({
        provId: "urld-prov-sa",
        name: "Provider SA",
        anthropicBaseUrl: null,
        openaiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", // Alibaba
      });
      await setupEndpointRoute({
        epId: "urld-ep-sa",
        routeId: "urld-route-sa",
        provId: "urld-prov-sa",
        incomingProtocol: "anthropic",
        providerProtocol: "anthropic",
      });

      const mock = mockFetchReturning(200);
      const response = await fastify.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
      });

      expect(response.statusCode).toBe(200);
      expect(mock.getUrl()).toContain("api.anthropic.com");
      expect(mock.getUrl()).not.toContain("dashscope.aliyuncs.com");
    });

    it("Scenario B: providerProtocol=openai, openaiBaseUrl=null, anthropicBaseUrl=Tencent", async () => {
      await setupProvider({
        provId: "urld-prov-sb",
        name: "Provider SB",
        openaiBaseUrl: null,
        anthropicBaseUrl: "https://api.hunyuan.cloud.tencent.com/v1", // Tencent
      });
      await setupEndpointRoute({
        epId: "urld-ep-sb",
        routeId: "urld-route-sb",
        provId: "urld-prov-sb",
        incomingProtocol: "openai",
        providerProtocol: "openai",
      });

      const mock = mockFetchReturning(200);
      const response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
      });

      expect(response.statusCode).toBe(200);
      expect(mock.getUrl()).toContain("api.openai.com");
      expect(mock.getUrl()).not.toContain("api.hunyuan.cloud.tencent.com");
    });

    it("Scenario C: providerProtocol=anthropic, anthropicBaseUrl=null, openaiBaseUrl=OpenRouter (OpenRouter enabled)", async () => {
      delete process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS;
      await setupProvider({
        provId: "urld-prov-sc",
        name: "Provider SC",
        anthropicBaseUrl: null,
        openaiBaseUrl: "https://openrouter.ai/api/v1",
      });
      await setupEndpointRoute({
        epId: "urld-ep-sc",
        routeId: "urld-route-sc",
        provId: "urld-prov-sc",
        incomingProtocol: "anthropic",
        providerProtocol: "anthropic",
      });

      const mock = mockFetchReturning(200);
      const response = await fastify.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
      });

      expect(response.statusCode).toBe(200);
      expect(mock.getUrl()).toContain("openrouter.ai");
      expect(mock.getUrl()).toContain("/api/v1/messages");
    });

    it("Scenario D: providerProtocol=anthropic, anthropicBaseUrl=null, openaiBaseUrl=OpenRouter (OpenRouter disabled)", async () => {
      process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = "openrouter";
      await setupProvider({
        provId: "urld-prov-sd",
        name: "Provider SD",
        anthropicBaseUrl: null,
        openaiBaseUrl: "https://openrouter.ai/api/v1",
      });
      await setupEndpointRoute({
        epId: "urld-ep-sd",
        routeId: "urld-route-sd",
        provId: "urld-prov-sd",
        incomingProtocol: "anthropic",
        providerProtocol: "anthropic",
      });

      // Stub global fetch to capture request details
      let fetchUrl = "";
      vi.stubGlobal("fetch", async (url: string, init?: any) => {
        fetchUrl = url;
        return new Response(JSON.stringify({
          id: "msg_123",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 5 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      });

      // Inject request
      const response = await fastify.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchUrl).toContain("openrouter.ai");
      expect(fetchUrl).not.toContain("api.anthropic.com");
    });
  });
});
