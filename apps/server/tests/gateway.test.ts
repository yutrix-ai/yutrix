import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq, sql } from "drizzle-orm";

// Set DB_FILE env var to test sqlite file before importing db/bootstrap
const testDbPath = "data/promptgate_test.sqlite";
process.env.DB_FILE = testDbPath;

let db: any;
let bootstrap: any;
let apiKeys: any;
let chatLogs: any;
let endpoints: any;
let endpointRoutes: any;
let providerApiKeys: any;
let providerModels: any;
let providers: any;
let routeAuthorizations: any;
let systemSettings: any;
let users: any;
let userGroupMembers: any;
let userGroups: any;
let gatewayRoutes: any;
let encryptText: any;

const getResolvedDbPath = () => {
  if (process.cwd().endsWith("server")) {
    return path.join(process.cwd(), "../../", testDbPath);
  }
  return path.join(process.cwd(), testDbPath);
};

describe("Gateway Models Endpoint", () => {
  const fastify = Fastify();
  let apiKey = "";
  let userId = "";

  beforeAll(async () => {
    // Delete existing test DB if any
    const resolvedPath = getResolvedDbPath();
    if (fs.existsSync(resolvedPath)) {
      try {
        fs.unlinkSync(resolvedPath);
      } catch (e) {}
    }
    if (fs.existsSync(resolvedPath + "-wal")) {
      try {
        fs.unlinkSync(resolvedPath + "-wal");
      } catch (e) {}
    }
    if (fs.existsSync(resolvedPath + "-shm")) {
      try {
        fs.unlinkSync(resolvedPath + "-shm");
      } catch (e) {}
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
      routeAuthorizations,
      systemSettings,
      users,
      userGroupMembers,
      userGroups,
    } = await import("../src/db/schema"));
    gatewayRoutes = (await import("../src/routes/gateway")).default;
    ({ encryptText } = await import("../src/utils/crypto"));

    const migrationsFolder = path.resolve(
      process.cwd(),
      process.cwd().endsWith("server") ? "./drizzle" : "apps/server/drizzle",
    );
    await migrate(db, { migrationsFolder });
    // Run migrations and bootstrap admin user
    await bootstrap();

    const providersInfo = await db.run(sql`PRAGMA table_info(providers)`);
    const providerColumnNames = providersInfo.rows.map((row: any) => row[1]);
    expect(providerColumnNames).not.toContain("openaiApiKeyEncrypted");
    expect(providerColumnNames).not.toContain("anthropicApiKeyEncrypted");

    // Register gateway routes
    fastify.register(gatewayRoutes);
    await fastify.ready();

    // Delete existing test user if any to prevent UNIQUE constraint failure
    await db.delete(users).where(eq(users.username, "testuser"));

    // Create a test user
    userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: "testuser",
      passwordHash: "dummy",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create a test API key for the user
    const rawKey = "pg_key_test_" + crypto.randomBytes(16).toString("hex");
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      userId: userId,
      name: "Test API Key",
      keyHash: keyHash,
      keyPrefix: rawKey.substring(0, 12),
      status: "active",
      concurrencyLimit: 10,
      createdAt: new Date(),
    });
    apiKey = rawKey;

    // Delete existing provider models first for this provider
    await db.delete(providerModels).where(eq(providerModels.providerId, "test-provider"));

    // Insert active models
    await db.insert(providerModels).values([
      {
        id: crypto.randomUUID(),
        providerId: "test-provider",
        modelId: "glm-5.1",
        displayName: "GLM 5.1",
        enabled: true,
        active: true,
        createdAt: new Date(),
      },
      {
        id: crypto.randomUUID(),
        providerId: "test-provider",
        modelId: "gpt-4o-test",
        displayName: "GPT-4o Test",
        enabled: true,
        active: true,
        createdAt: new Date(),
      },
      {
        id: crypto.randomUUID(),
        providerId: "test-provider",
        modelId: "disabled-model",
        displayName: "Disabled Model",
        enabled: false,
        active: true,
        createdAt: new Date(),
      }
    ]);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await fastify.close();
    // Clean up test DB file
    const resolvedPath = getResolvedDbPath();
    if (fs.existsSync(resolvedPath)) {
      try {
        fs.unlinkSync(resolvedPath);
      } catch (e) {}
    }
  });

  it("returns 401 if API key is missing", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/v1/models",
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("invalid_api_key");
  });

  it("returns 401 if API key is invalid", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer invalid_key_here",
      },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("invalid_api_key");
  });

  it("returns list of active & enabled models when request is authenticated", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe("list");
    expect(body.data).toBeInstanceOf(Array);

    // Model discovery is enabled by default via bootstrap seeding,
    // so /v1/models returns the custom discovery list, NOT providerModels.
    const modelIds = body.data.map((m: any) => m.id);
    // Should contain seeded OpenAI models
    expect(modelIds).toContain("gpt-4.1");
    expect(modelIds).toContain("o3");
    // Should contain seeded Anthropic models
    expect(modelIds).toContain("claude-opus-4-20250918");
    // Should NOT contain providerModels (they are independent)
    expect(modelIds).not.toContain("glm-5.1");
    expect(modelIds).not.toContain("disabled-model");

    // Check OpenAI format attributes
    const gptModel = body.data.find((m: any) => m.id === "gpt-4.1");
    expect(gptModel.object).toBe("model");
    expect(gptModel.owned_by).toBe("openai");
    expect(typeof gptModel.created).toBe("number");
  });

  it("also supports the alternative /models path", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/models",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe("list");
    const modelIds = body.data.map((m: any) => m.id);
    expect(modelIds).toContain("gpt-4.1");
    expect(modelIds).toContain("claude-opus-4-20250918");
  });

  it("returns L0 route models when model discovery is disabled", async () => {
    // --- Setup: create a provider, endpoint, and route ---
    const testProviderId = "test-route-discovery-provider";
    await db.delete(providers).where(eq(providers.id, testProviderId));
    await db.insert(providers).values({
      id: testProviderId,
      name: "Route Discovery Provider",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const testEndpointId = "test-route-discovery-endpoint";
    await db.delete(endpointRoutes).where(eq(endpointRoutes.endpointId, testEndpointId));
    await db.delete(endpoints).where(eq(endpoints.id, testEndpointId));
    await db.insert(endpoints).values({
      id: testEndpointId,
      userId,
      name: "test-route-discovery",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const testRouteId = "test-route-discovery-route";
    await db.insert(endpointRoutes).values({
      id: testRouteId,
      endpointId: testEndpointId,
      providerId: testProviderId,
      providerProtocol: "openai",
      modelId: "gpt-4o-from-route",
      enabled: true,
      status: "active",
      priority: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Disable model discovery
    await db
      .update(systemSettings)
      .set({ value: "false", updatedAt: new Date() })
      .where(eq(systemSettings.key, "modelDiscoveryEnabled"));

    const response = await fastify.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe("list");
    expect(body.data).toBeInstanceOf(Array);

    const modelIds = body.data.map((m: any) => m.id);
    // Should contain the L0 model from the route
    expect(modelIds).toContain("gpt-4o-from-route");
    // Should NOT contain "default" since routes exist
    expect(modelIds).not.toContain("default");

    // Verify owned_by is correctly inferred
    const routeModel = body.data.find((m: any) => m.id === "gpt-4o-from-route");
    expect(routeModel.owned_by).toBe("openai");
    expect(routeModel.object).toBe("model");

    // Cleanup
    await db.delete(endpointRoutes).where(eq(endpointRoutes.id, testRouteId));
    await db.delete(endpoints).where(eq(endpoints.id, testEndpointId));
    await db.delete(providers).where(eq(providers.id, testProviderId));

    // Re-enable model discovery
    await db
      .update(systemSettings)
      .set({ value: "true", updatedAt: new Date() })
      .where(eq(systemSettings.key, "modelDiscoveryEnabled"));
  });

  it("returns virtualModelAlias when set, not internal modelId", async () => {
    const testProviderId = "test-alias-provider";
    await db.delete(providers).where(eq(providers.id, testProviderId));
    await db.insert(providers).values({
      id: testProviderId,
      name: "Alias Provider",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const testEndpointId = "test-alias-endpoint";
    await db.delete(endpointRoutes).where(eq(endpointRoutes.endpointId, testEndpointId));
    await db.delete(endpoints).where(eq(endpoints.id, testEndpointId));
    await db.insert(endpoints).values({
      id: testEndpointId,
      userId,
      name: "test-alias",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      virtualModelAlias: "my-custom-model",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(endpointRoutes).values({
      id: "test-alias-route",
      endpointId: testEndpointId,
      providerId: testProviderId,
      providerProtocol: "openai",
      modelId: "internal-gpt4o-prod",
      enabled: true,
      status: "active",
      priority: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db
      .update(systemSettings)
      .set({ value: "false", updatedAt: new Date() })
      .where(eq(systemSettings.key, "modelDiscoveryEnabled"));

    const response = await fastify.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${apiKey}` },
    });

    const body = JSON.parse(response.body);
    const modelIds = body.data.map((m: any) => m.id);
    // Should expose virtualModelAlias, not internal modelId
    expect(modelIds).toContain("my-custom-model");
    expect(modelIds).not.toContain("internal-gpt4o-prod");

    // Cleanup
    await db.delete(endpointRoutes).where(eq(endpointRoutes.id, "test-alias-route"));
    await db.delete(endpoints).where(eq(endpoints.id, testEndpointId));
    await db.delete(providers).where(eq(providers.id, testProviderId));
    await db
      .update(systemSettings)
      .set({ value: "true", updatedAt: new Date() })
      .where(eq(systemSettings.key, "modelDiscoveryEnabled"));
  });

  it("extracts L0 model from targets JSON when present", async () => {
    const testProviderId = "test-targets-provider";
    await db.delete(providers).where(eq(providers.id, testProviderId));
    await db.insert(providers).values({
      id: testProviderId,
      name: "Targets Provider",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const testEndpointId = "test-targets-endpoint";
    await db.delete(endpointRoutes).where(eq(endpointRoutes.endpointId, testEndpointId));
    await db.delete(endpoints).where(eq(endpoints.id, testEndpointId));
    await db.insert(endpoints).values({
      id: testEndpointId,
      userId,
      name: "test-targets",
      path: "/v1/messages",
      incomingProtocol: "anthropic",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Route with targets JSON (L0 = claude-sonnet-4, L1 = fallback)
    await db.insert(endpointRoutes).values({
      id: "test-targets-route",
      endpointId: testEndpointId,
      providerId: testProviderId,
      providerProtocol: "anthropic",
      modelId: "old-model-field",
      targets: JSON.stringify([
        { providerId: testProviderId, providerProtocol: "anthropic", modelId: "claude-sonnet-4-20250514" },
        { providerId: testProviderId, providerProtocol: "anthropic", modelId: "claude-haiku-4-fallback" },
      ]),
      enabled: true,
      status: "active",
      priority: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db
      .update(systemSettings)
      .set({ value: "false", updatedAt: new Date() })
      .where(eq(systemSettings.key, "modelDiscoveryEnabled"));

    const response = await fastify.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${apiKey}` },
    });

    const body = JSON.parse(response.body);
    const modelIds = body.data.map((m: any) => m.id);

    // Should use targets[0].modelId, not route.modelId
    expect(modelIds).toContain("claude-sonnet-4-20250514");
    expect(modelIds).not.toContain("old-model-field");
    // Should NOT contain fallback (L1) model
    expect(modelIds).not.toContain("claude-haiku-4-fallback");

    // Verify owned_by for Anthropic model
    const claudeModel = body.data.find((m: any) => m.id === "claude-sonnet-4-20250514");
    expect(claudeModel.owned_by).toBe("anthropic");

    // Cleanup
    await db.delete(endpointRoutes).where(eq(endpointRoutes.id, "test-targets-route"));
    await db.delete(endpoints).where(eq(endpoints.id, testEndpointId));
    await db.delete(providers).where(eq(providers.id, testProviderId));
    await db
      .update(systemSettings)
      .set({ value: "true", updatedAt: new Date() })
      .where(eq(systemSettings.key, "modelDiscoveryEnabled"));
  });

  it("falls back to 'default' when discovery disabled and no routes exist", async () => {
    // Disable model discovery – no routes/endpoints created
    await db
      .update(systemSettings)
      .set({ value: "false", updatedAt: new Date() })
      .where(eq(systemSettings.key, "modelDiscoveryEnabled"));

    // Delete all endpoints/routes to simulate empty config
    await db.delete(endpointRoutes);
    await db.delete(endpoints);

    const response = await fastify.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe("list");
    expect(body.data.length).toBe(1);
    expect(body.data[0].id).toBe("default");
    expect(body.data[0].owned_by).toBe("promptgate");

    // Re-enable model discovery
    await db
      .update(systemSettings)
      .set({ value: "true", updatedAt: new Date() })
      .where(eq(systemSettings.key, "modelDiscoveryEnabled"));
  });

  it("resolves effective input token limits from groups and user overrides", async () => {
    const { resolveEffectiveMaxInputTokens } = await import("../src/services/userTokenLimits");
    const now = new Date();
    const localUserId = crypto.randomUUID();
    const permissiveGroupId = crypto.randomUUID();
    const strictGroupId = crypto.randomUUID();

    try {
      await db.insert(users).values({
        id: localUserId,
        username: `limit-user-${localUserId}`,
        passwordHash: "dummy",
        role: "user",
        status: "active",
        maxInputTokensOverride: null,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(userGroups).values([
        {
          id: permissiveGroupId,
          name: `limit-permissive-${permissiveGroupId}`,
          description: null,
          isDefault: false,
          maxInputTokens: 32000,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: strictGroupId,
          name: `limit-strict-${strictGroupId}`,
          description: null,
          isDefault: false,
          maxInputTokens: 12000,
          createdAt: now,
          updatedAt: now,
        },
      ]);
      await db.insert(userGroupMembers).values([
        {
          id: crypto.randomUUID(),
          groupId: permissiveGroupId,
          userId: localUserId,
          createdAt: now,
        },
        {
          id: crypto.randomUUID(),
          groupId: strictGroupId,
          userId: localUserId,
          createdAt: now,
        },
      ]);

      await expect(resolveEffectiveMaxInputTokens(localUserId)).resolves.toMatchObject({
        maxInputTokens: 12000,
        source: "group",
        groupId: strictGroupId,
      });

      await db
        .update(users)
        .set({ maxInputTokensOverride: 0 })
        .where(eq(users.id, localUserId));
      await expect(resolveEffectiveMaxInputTokens(localUserId)).resolves.toMatchObject({
        maxInputTokens: 0,
        source: "user_override",
      });

      await db
        .update(users)
        .set({ maxInputTokensOverride: 4096 })
        .where(eq(users.id, localUserId));
      await expect(resolveEffectiveMaxInputTokens(localUserId)).resolves.toMatchObject({
        maxInputTokens: 4096,
        source: "user_override",
      });

      await db
        .update(users)
        .set({ maxInputTokensOverride: null })
        .where(eq(users.id, localUserId));
      await db
        .update(userGroups)
        .set({ maxInputTokens: 0 })
        .where(eq(userGroups.id, strictGroupId));
      await expect(resolveEffectiveMaxInputTokens(localUserId)).resolves.toMatchObject({
        maxInputTokens: 32000,
        source: "group",
        groupId: permissiveGroupId,
      });
    } finally {
      await db.delete(userGroupMembers).where(eq(userGroupMembers.userId, localUserId));
      await db.delete(userGroups).where(eq(userGroups.id, permissiveGroupId));
      await db.delete(userGroups).where(eq(userGroups.id, strictGroupId));
      await db.delete(users).where(eq(users.id, localUserId));
    }
  });

  it("applies strategy routing before forwarding the upstream request", async () => {
    const now = new Date();
    const primaryProviderId = "strategy-primary-provider";
    const debugProviderId = "strategy-debug-provider";
    const endpointId = "strategy-endpoint";
    const routeId = "strategy-route";

    await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, routeId));
    await db.delete(endpointRoutes).where(eq(endpointRoutes.id, routeId));
    await db.delete(endpoints).where(eq(endpoints.id, endpointId));
    await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, primaryProviderId));
    await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, debugProviderId));
    await db.delete(providerModels).where(eq(providerModels.providerId, primaryProviderId));
    await db.delete(providerModels).where(eq(providerModels.providerId, debugProviderId));
    await db.delete(providers).where(eq(providers.id, primaryProviderId));
    await db.delete(providers).where(eq(providers.id, debugProviderId));
    await db.delete(systemSettings).where(eq(systemSettings.key, "allowUnknownHostFallback"));

    await db.insert(systemSettings).values({
      key: "allowUnknownHostFallback",
      value: "true",
      description: "gateway strategy routing test fallback",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(providers).values([
      {
        id: primaryProviderId,
        name: "Strategy Primary Provider",
        openaiBaseUrl: "https://primary-upstream.test/v1",
        anthropicBaseUrl: null,
        enabled: true,
        concurrencyLimit: 10,
        timeoutMs: 30000,
        maxOutputTokens: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: debugProviderId,
        name: "Strategy Debug Provider",
        openaiBaseUrl: "https://debug-upstream.test/v1",
        anthropicBaseUrl: null,
        enabled: true,
        concurrencyLimit: 10,
        timeoutMs: 30000,
        maxOutputTokens: 0,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(providerModels).values([
      {
        id: crypto.randomUUID(),
        providerId: primaryProviderId,
        modelId: "base-model",
        displayName: "Base Model",
        enabled: true,
        active: true,
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        providerId: debugProviderId,
        modelId: "debug-model",
        displayName: "Debug Model",
        enabled: true,
        active: true,
        createdAt: now,
      },
    ]);

    await db.insert(providerApiKeys).values([
      {
        id: "strategy-primary-key",
        providerId: primaryProviderId,
        keyEncrypted: encryptText("sk-primary"),
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "strategy-debug-key",
        providerId: debugProviderId,
        keyEncrypted: encryptText("sk-debug"),
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(endpoints).values({
      id: endpointId,
      userId,
      name: "Strategy Endpoint",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(endpointRoutes).values({
      id: routeId,
      name: "Strategy Route",
      endpointId,
      providerId: primaryProviderId,
      providerProtocol: "openai",
      modelId: "base-model",
      strategyRoutingEnabled: true,
      strategyRoutingRules: JSON.stringify([
        {
          taskType: "debug",
          providerId: debugProviderId,
          providerProtocol: "openai",
          modelId: "debug-model",
          enabled: true,
        },
        {
          taskType: "general",
          providerId: primaryProviderId,
          providerProtocol: "openai",
          modelId: "base-model",
          enabled: true,
        },
      ]),
      enabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId,
      userId,
      createdAt: now,
    });

    const upstreamCalls: Array<{ url: string; model: string; authorization: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      const headers = init?.headers as Record<string, string> | undefined;
      upstreamCalls.push({
        url,
        model: body.model,
        authorization: headers?.Authorization || "",
      });
      return new Response(
        JSON.stringify({
          id: "chatcmpl-strategy",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
      payload: {
        model: "base-model",
        messages: [{ role: "user", content: "这个接口 timeout 报错，请帮我修复" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(upstreamCalls).toEqual([
      {
        url: "https://debug-upstream.test/v1/chat/completions",
        model: "debug-model",
        authorization: "Bearer sk-debug",
      },
    ]);

    await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, routeId));
    await db.delete(endpointRoutes).where(eq(endpointRoutes.id, routeId));
    await db.delete(endpoints).where(eq(endpoints.id, endpointId));
  });

  it("merges two turns with the same clientSessionId into the same serverSessionId (Priority 0)", async () => {
    const { logEmitter } = await import("../src/utils/events");
    await import("../src/services/chatLogService");

    const clientSessionId = "test-conv-id-" + crypto.randomUUID();

    // First turn
    const firstReqId = crypto.randomUUID();
    logEmitter.emit("chatLogInsert", {
      id: firstReqId,
      requestId: firstReqId,
      clientSessionId,
      userId,
      clientName: "Test API Key",
      model: "gpt-4o-test",
      inputText: JSON.stringify([{ role: "user", content: "hello" }]),
      outputText: "hi",
    });

    // Wait for insertion
    await new Promise(resolve => setTimeout(resolve, 300));

    // Retrieve first insert
    const logs1 = await db.select().from(chatLogs).where(eq(chatLogs.requestId, firstReqId));
    expect(logs1.length).toBe(1);
    const serverSessionId = logs1[0].serverSessionId;
    expect(serverSessionId).toBeDefined();
    expect(logs1[0].turnId).toBe(0);
    expect(logs1[0].clientSessionId).toBe(clientSessionId);

    // Second turn with different prompt, should merge under same serverSessionId
    const secondReqId = crypto.randomUUID();
    logEmitter.emit("chatLogInsert", {
      id: secondReqId,
      requestId: secondReqId,
      clientSessionId,
      userId,
      clientName: "Test API Key",
      model: "gpt-4o-test",
      inputText: JSON.stringify([{ role: "user", content: "how are you" }]),
      outputText: "I am good",
    });

    // Wait for insertion
    await new Promise(resolve => setTimeout(resolve, 300));

    // Retrieve second insert
    const logs2 = await db.select().from(chatLogs).where(eq(chatLogs.requestId, secondReqId));
    expect(logs2.length).toBe(1);
    expect(logs2[0].serverSessionId).toBe(serverSessionId);
    expect(logs2[0].turnId).toBe(1);
    expect(logs2[0].clientSessionId).toBe(clientSessionId);
  });

  it("merges concurrent inserts that share a clientSessionId with monotonic turnIds", async () => {
    const { logEmitter } = await import("../src/utils/events");
    await import("../src/services/chatLogService");

    const clientSessionId = "concurrent-conv-" + crypto.randomUUID();
    const firstReqId = crypto.randomUUID();
    const secondReqId = crypto.randomUUID();

    logEmitter.emit("chatLogInsert", {
      id: firstReqId,
      requestId: firstReqId,
      clientSessionId,
      userId,
      clientName: "Test API Key",
      model: "gpt-4o-test",
      inputText: JSON.stringify([{ role: "user", content: "first concurrent turn" }]),
      outputText: "one",
    });
    logEmitter.emit("chatLogInsert", {
      id: secondReqId,
      requestId: secondReqId,
      clientSessionId,
      userId,
      clientName: "Test API Key",
      model: "gpt-4o-test",
      inputText: JSON.stringify([{ role: "user", content: "second concurrent turn" }]),
      outputText: "two",
    });

    const deadline = Date.now() + 2000;
    let rows: any[] = [];
    while (Date.now() < deadline) {
      rows = await db.select().from(chatLogs).where(eq(chatLogs.clientSessionId, clientSessionId));
      if (rows.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(rows.length).toBe(2);
    const sessionIds = new Set(rows.map((row: any) => row.serverSessionId));
    expect(sessionIds.size).toBe(1);
    const turnIds = rows.map((row: any) => row.turnId).sort((a: number, b: number) => a - b);
    expect(turnIds).toEqual([0, 1]);
  });

  it("merges a real prompt into a preceding generated-title session by subject text", async () => {
    const { logEmitter } = await import("../src/utils/events");
    await import("../src/services/chatLogService");
    await db.delete(chatLogs).where(eq(chatLogs.userId, userId));

    const userPrompt = "review昨日提交的代码";
    const titleReqId = crypto.randomUUID();

    logEmitter.emit("chatLogInsert", {
      id: titleReqId,
      requestId: titleReqId,
      serverSessionId: titleReqId,
      userId,
      clientName: "Test API Key",
      detectedClient: "Cursor",
      model: "gpt-4o-test",
      inputText: JSON.stringify([
        { role: "user", content: "Generate a title for this conversation:\n" },
        { role: "user", content: userPrompt },
      ]),
      outputText: "审查昨日提交代码",
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    const titleLogs = await db.select().from(chatLogs).where(eq(chatLogs.requestId, titleReqId));
    expect(titleLogs.length).toBe(1);
    const serverSessionId = titleLogs[0].serverSessionId;
    expect(serverSessionId).toBe(titleReqId);

    const realReqId = crypto.randomUUID();
    logEmitter.emit("chatLogInsert", {
      id: realReqId,
      requestId: realReqId,
      serverSessionId: realReqId,
      userId,
      clientName: "Test API Key",
      detectedClient: "Codex CLI",
      model: "gpt-4o-test",
      inputText: userPrompt,
      outputText: "<think>internal</think>\n<tool_calls>[]</tool_calls>",
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    const realLogs = await db.select().from(chatLogs).where(eq(chatLogs.requestId, realReqId));
    expect(realLogs.length).toBe(1);
    expect(realLogs[0].serverSessionId).toBe(serverSessionId);
    expect(realLogs[0].turnId).toBe(1);
  });

  it("merges a delegated prompt into the parent tool-call session", async () => {
    const { logEmitter } = await import("../src/utils/events");
    await import("../src/services/chatLogService");
    await db.delete(chatLogs).where(eq(chatLogs.userId, userId));

    const delegatedPrompt = "I need you to do a thorough code review of yesterday's git commits.";
    const parentReqId = crypto.randomUUID();

    logEmitter.emit("chatLogInsert", {
      id: parentReqId,
      requestId: parentReqId,
      serverSessionId: parentReqId,
      userId,
      clientName: "Test API Key",
      detectedClient: "Codex CLI",
      model: "gpt-4o-test",
      inputText: JSON.stringify([
        { role: "tool", content: "commit list", tool_call_id: "call_5ca3647678ee4ee0b15ca469" },
      ]),
      outputText: `<think>delegating</think>\n<tool_calls>${JSON.stringify([
        {
          id: "call_1cc80c975aa74a28a8d18a3b",
          type: "function",
          function: {
            name: "spawn_worker",
            arguments: JSON.stringify({
              description: "Review yesterday's code changes",
              worker_type: "general",
              instructions: delegatedPrompt,
            }),
          },
        },
      ])}</tool_calls>`,
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    const parentLogs = await db.select().from(chatLogs).where(eq(chatLogs.requestId, parentReqId));
    expect(parentLogs.length).toBe(1);

    const subagentReqId = crypto.randomUUID();
    logEmitter.emit("chatLogInsert", {
      id: subagentReqId,
      requestId: subagentReqId,
      serverSessionId: subagentReqId,
      userId,
      clientName: "Test API Key",
      detectedClient: "Task Runner",
      model: "gpt-4o-test",
      inputText: delegatedPrompt,
      outputText: "<think>working</think>\n<tool_calls>[]</tool_calls>",
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    const subagentLogs = await db.select().from(chatLogs).where(eq(chatLogs.requestId, subagentReqId));
    expect(subagentLogs.length).toBe(1);
    expect(subagentLogs[0].serverSessionId).toBe(parentLogs[0].serverSessionId);
    expect(subagentLogs[0].turnId).toBe(1);
  });

  it("round-robins active provider API keys and skips exhausted keys", async () => {
    const now = new Date();
    const providerId = "rotation-provider";
    const endpointId = "rotation-endpoint";
    const routeId = "rotation-route";
    const modelId = "rotation-model";

    await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, "strategy-route"));
    await db.delete(endpointRoutes).where(eq(endpointRoutes.id, "strategy-route"));
    await db.delete(endpoints).where(eq(endpoints.id, "strategy-endpoint"));
    await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, routeId));
    await db.delete(endpointRoutes).where(eq(endpointRoutes.id, routeId));
    await db.delete(endpoints).where(eq(endpoints.id, endpointId));
    await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, providerId));
    await db.delete(providerModels).where(eq(providerModels.providerId, providerId));
    await db.delete(providers).where(eq(providers.id, providerId));
    await db.delete(systemSettings).where(eq(systemSettings.key, "allowUnknownHostFallback"));

    await db.insert(systemSettings).values({
      key: "allowUnknownHostFallback",
      value: "true",
      description: "gateway test fallback",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(providers).values({
      id: providerId,
      name: "Rotation Provider",
      openaiBaseUrl: "https://upstream.test/v1",
      anthropicBaseUrl: "https://anthropic-upstream.test",
      enabled: true,
      concurrencyLimit: 10,
      timeoutMs: 30000,
      maxOutputTokens: 0,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId,
      modelId,
      displayName: "Rotation Model",
      enabled: true,
      active: true,
      createdAt: now,
    });

    await db.insert(providerApiKeys).values([
      {
        id: "rotation-key-a",
        providerId,
        keyEncrypted: encryptText("sk-rotation-a"),
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "rotation-key-b",
        providerId,
        keyEncrypted: encryptText("sk-rotation-b"),
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(endpoints).values({
      id: endpointId,
      userId,
      name: "Rotation Endpoint",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(endpointRoutes).values({
      id: routeId,
      name: "Rotation Route",
      endpointId,
      providerId,
      providerProtocol: "openai",
      modelId,
      enabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId,
      userId,
      createdAt: now,
    });

    const seenAuthHeaders: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seenAuthHeaders.push(headers?.Authorization || "");
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const sendGatewayRequest = () =>
      fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        payload: {
          model: modelId,
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        },
      });

    const first = await sendGatewayRequest();
    const second = await sendGatewayRequest();
    const third = await sendGatewayRequest();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(200);
    expect(seenAuthHeaders).toEqual([
      "Bearer sk-rotation-a",
      "Bearer sk-rotation-b",
      "Bearer sk-rotation-a",
    ]);

    await db
      .update(providerApiKeys)
      .set({ status: "exhausted", updatedAt: new Date() })
      .where(eq(providerApiKeys.id, "rotation-key-a"));

    seenAuthHeaders.length = 0;
    const fourth = await sendGatewayRequest();
    const fifth = await sendGatewayRequest();

    expect(fourth.statusCode).toBe(200);
    expect(fifth.statusCode).toBe(200);
    expect(seenAuthHeaders).toEqual([
      "Bearer sk-rotation-b",
      "Bearer sk-rotation-b",
    ]);
  });

  it("cascades requests through the targets funnel routing grid upon rate limits or server errors with best effort同名 matching", async () => {
    const now = new Date();
    const endpointId = "funnel-endpoint";
    const routeId = "funnel-route";

    // Clean up
    await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, routeId));
    await db.delete(endpointRoutes).where(eq(endpointRoutes.id, routeId));
    await db.delete(endpoints).where(eq(endpoints.id, endpointId));
    await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, "rotation-route"));
    await db.delete(endpointRoutes).where(eq(endpointRoutes.id, "rotation-route"));
    await db.delete(endpoints).where(eq(endpoints.id, "rotation-endpoint"));
    await db.delete(providerApiKeys).where(sql`providerId LIKE 'funnel-p%'`);
    await db.delete(providerModels).where(sql`providerId LIKE 'funnel-p%'`);
    await db.delete(providers).where(sql`id LIKE 'funnel-p%'`);
    await db.delete(systemSettings).where(eq(systemSettings.key, "allowUnknownHostFallback"));
    await db.insert(systemSettings).values({
      key: "allowUnknownHostFallback",
      value: "true",
      description: "funnel routing test host fallback",
      createdAt: now,
      updatedAt: now,
    });

    // Insert 3 providers
    await db.insert(providers).values([
      {
        id: "funnel-p1",
        name: "Funnel Provider 1",
        openaiBaseUrl: "https://p1.test/v1",
        anthropicBaseUrl: null,
        enabled: true,
        concurrencyLimit: 10,
        timeoutMs: 30000,
        maxOutputTokens: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "funnel-p2",
        name: "Funnel Provider 2",
        openaiBaseUrl: "https://openrouter.ai/api/v1",
        anthropicBaseUrl: null,
        enabled: true,
        concurrencyLimit: 10,
        timeoutMs: 30000,
        maxOutputTokens: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "funnel-p3",
        name: "Funnel Provider 3",
        openaiBaseUrl: "https://p3.test/v1",
        anthropicBaseUrl: null,
        enabled: true,
        concurrencyLimit: 10,
        timeoutMs: 30000,
        maxOutputTokens: 0,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // Insert provider models (including same-named model 'model-1' on p3 for bestEffort testing)
    await db.insert(providerModels).values([
      {
        id: crypto.randomUUID(),
        providerId: "funnel-p1",
        modelId: "model-1",
        displayName: "Model 1",
        enabled: true,
        active: true,
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        providerId: "funnel-p2",
        modelId: "model-2",
        displayName: "Model 2",
        enabled: true,
        active: true,
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        providerId: "funnel-p3",
        modelId: "model-3",
        displayName: "Model 3",
        enabled: true,
        active: true,
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        providerId: "funnel-p3",
        modelId: "model-2", // Same name as L2 model
        displayName: "Model 2 on P3",
        enabled: true,
        active: true,
        createdAt: now,
      },
    ]);

    await db.insert(providerApiKeys).values([
      {
        id: "funnel-k1",
        providerId: "funnel-p1",
        keyEncrypted: encryptText("sk-p1"),
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "funnel-k2",
        providerId: "funnel-p2",
        keyEncrypted: encryptText("sk-p2"),
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "funnel-k3",
        providerId: "funnel-p3",
        keyEncrypted: encryptText("sk-p3"),
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(endpoints).values({
      id: endpointId,
      userId,
      name: "Funnel Endpoint",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    // Configure targets grid: P1 -> P2 -> P3 (with bestEffort enabled on P3 target layer)
    const targets = [
      {
        providerId: "funnel-p1",
        modelId: "model-1",
        providerProtocol: "openai",
        bestEffort: false,
        strategyRoutingEnabled: false,
        strategyRoutingRules: [],
      },
      {
        providerId: "funnel-p2",
        modelId: "model-2",
        providerProtocol: "openai",
        bestEffort: false,
        strategyRoutingEnabled: false,
        strategyRoutingRules: [],
      },
      {
        providerId: "funnel-p3",
        modelId: "model-3",
        providerProtocol: "openai",
        bestEffort: true, // Should trigger bestEffort and match 'model-2'!
        strategyRoutingEnabled: false,
        strategyRoutingRules: [],
      },
    ];

    await db.insert(endpointRoutes).values({
      id: routeId,
      name: "Funnel Route",
      endpointId,
      providerId: "funnel-p1",
      providerProtocol: "openai",
      modelId: "model-1",
      targets: JSON.stringify(targets),
      enabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId,
      userId,
      createdAt: now,
    });

    const receivedCalls: Array<{ url: string; model: string; key: string }> = [];

    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const body = JSON.parse(String(init?.body || "{}"));

      receivedCalls.push({
        url,
        model: body.model,
        key: headers?.Authorization || "",
      });

      if (url.includes("p1.test")) {
        return new Response(
          JSON.stringify({ error: { message: "Too many requests" } }),
          { status: 429, headers: { "content-type": "application/json" } }
        );
      }

      if (url.includes("openrouter.ai")) {
        return new Response(
          JSON.stringify({ error: { message: "ResourceExhausted: Provider capacity exhausted" } }),
          { status: 503, headers: { "content-type": "application/json" } }
        );
      }

      if (url.includes("p3.test")) {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-funnel-success",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              { index: 0, message: { role: "assistant", content: "cascading success" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response("Not found", { status: 404 });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
      payload: {
        model: "model-1",
        messages: [{ role: "user", content: "test cascading funnel" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    const resBody = JSON.parse(response.body);
    expect(resBody.choices[0].message.content).toBe("cascading success");

    // Verify all attempts were made sequentially (including 2 capacity retries on P2)
    expect(receivedCalls).toHaveLength(5);

    // First attempt: P1 with model-1
    expect(receivedCalls[0]).toEqual({
      url: "https://p1.test/v1/chat/completions",
      model: "model-1",
      key: "Bearer sk-p1",
    });

    // Second attempt: P2 with model-2 (specified model for Layer 2)
    expect(receivedCalls[1]).toEqual({
      url: "https://openrouter.ai/api/v1/chat/completions",
      model: "model-2",
      key: "Bearer sk-p2",
    });

    // Third attempt (capacity retry 1 on P2)
    expect(receivedCalls[2]).toEqual({
      url: "https://openrouter.ai/api/v1/chat/completions",
      model: "model-2",
      key: "Bearer sk-p2",
    });

    // Fourth attempt (capacity retry 2 on P2)
    expect(receivedCalls[3]).toEqual({
      url: "https://openrouter.ai/api/v1/chat/completions",
      model: "model-2",
      key: "Bearer sk-p2",
    });

    // Fifth attempt: P3. Since bestEffort = true, it should match the same name "model-2" instead of L3's default "model-3"
    expect(receivedCalls[4]).toEqual({
      url: "https://p3.test/v1/chat/completions",
      model: "model-2",
      key: "Bearer sk-p3",
    });

    // Clean up
    await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, routeId));
    await db.delete(endpointRoutes).where(eq(endpointRoutes.id, routeId));
    await db.delete(endpoints).where(eq(endpoints.id, endpointId));
    await db.delete(providerApiKeys).where(sql`providerId LIKE 'funnel-p%'`);
    await db.delete(providerModels).where(sql`providerId LIKE 'funnel-p%'`);
    await db.delete(providers).where(sql`id LIKE 'funnel-p%'`);
  });

  it("falls through to L1 immediately on 当前无可用凭证 without burning same-key 5xx budget", async () => {
    // Credential-pool empty is non-transient: do NOT same-key retry until maxAttempts.
    // Still must invoke L1 via 路由错误降级 (and never surface 网关内部错误).
    const now = new Date();
    const endpointId = "funnel-500-endpoint";
    const routeId = "funnel-500-route";

    await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, routeId));
    await db.delete(endpointRoutes).where(eq(endpointRoutes.id, routeId));
    await db.delete(endpoints).where(eq(endpoints.id, endpointId));
    await db.delete(providerApiKeys).where(sql`providerId LIKE 'funnel500-p%'`);
    await db.delete(providerModels).where(sql`providerId LIKE 'funnel500-p%'`);
    await db.delete(providers).where(sql`id LIKE 'funnel500-p%'`);
    await db.delete(systemSettings).where(eq(systemSettings.key, "allowUnknownHostFallback"));
    await db.insert(systemSettings).values({
      key: "allowUnknownHostFallback",
      value: "true",
      description: "funnel 500 exhaustion host fallback",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(providers).values([
      {
        id: "funnel500-p1",
        name: "Funnel500 Provider L0",
        openaiBaseUrl: "https://p1-500.test/v1",
        anthropicBaseUrl: null,
        enabled: true,
        concurrencyLimit: 10,
        timeoutMs: 30000,
        maxOutputTokens: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "funnel500-p2",
        name: "Funnel500 Provider L1",
        openaiBaseUrl: "https://p2-500.test/v1",
        anthropicBaseUrl: null,
        enabled: true,
        concurrencyLimit: 10,
        timeoutMs: 30000,
        maxOutputTokens: 0,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(providerModels).values([
      {
        id: crypto.randomUUID(),
        providerId: "funnel500-p1",
        modelId: "gemini-high",
        displayName: "Gemini High",
        enabled: true,
        active: true,
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        providerId: "funnel500-p2",
        modelId: "kimi-k2.5",
        displayName: "Kimi K2.5",
        enabled: true,
        active: true,
        createdAt: now,
      },
    ]);

    await db.insert(providerApiKeys).values([
      {
        id: "funnel500-k1",
        providerId: "funnel500-p1",
        keyEncrypted: encryptText("sk-l0"),
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "funnel500-k2",
        providerId: "funnel500-p2",
        keyEncrypted: encryptText("sk-l1"),
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(endpoints).values({
      id: endpointId,
      userId,
      name: "Funnel 500 Endpoint",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    // maxAttempts = retryCount(4) + targets(2) = 6 — matches production attempt=x/6 logs
    const targets = [
      {
        providerId: "funnel500-p1",
        modelId: "gemini-high",
        providerProtocol: "openai",
        bestEffort: false,
        strategyRoutingEnabled: false,
        strategyRoutingRules: [],
      },
      {
        providerId: "funnel500-p2",
        modelId: "kimi-k2.5",
        providerProtocol: "openai",
        bestEffort: false,
        strategyRoutingEnabled: false,
        strategyRoutingRules: [],
      },
    ];

    await db.insert(endpointRoutes).values({
      id: routeId,
      name: "Funnel 500 Route",
      endpointId,
      providerId: "funnel500-p1",
      providerProtocol: "openai",
      modelId: "gemini-high",
      retryCount: 4,
      targets: JSON.stringify(targets),
      enabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId,
      userId,
      createdAt: now,
    });

    const receivedCalls: Array<{ url: string; model: string }> = [];

    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      receivedCalls.push({ url: String(url), model: body.model });

      if (String(url).includes("p1-500.test")) {
        return new Response(
          JSON.stringify({ error: "当前无可用凭证" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      if (String(url).includes("p2-500.test")) {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-funnel500-success",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              { index: 0, message: { role: "assistant", content: "l1 fallback success" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
      payload: {
        model: "gemini-high",
        messages: [{ role: "user", content: "test 500 budget exhaustion funnel" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    const resBody = JSON.parse(response.body);
    expect(resBody.choices[0].message.content).toBe("l1 fallback success");

    // L0 is hit once (no same-key blind retries), then L1 succeeds
    const l0Calls = receivedCalls.filter((c) => c.url.includes("p1-500.test"));
    const l1Calls = receivedCalls.filter((c) => c.url.includes("p2-500.test"));
    expect(l0Calls.length).toBe(1);
    expect(l1Calls.length).toBe(1);
    expect(l1Calls[0].model).toBe("kimi-k2.5");

    // Must not surface the null-responseData internal error
    expect(JSON.stringify(resBody)).not.toContain("网关内部错误");

    await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, routeId));
    await db.delete(endpointRoutes).where(eq(endpointRoutes.id, routeId));
    await db.delete(endpoints).where(eq(endpoints.id, endpointId));
    await db.delete(providerApiKeys).where(sql`providerId LIKE 'funnel500-p%'`);
    await db.delete(providerModels).where(sql`providerId LIKE 'funnel500-p%'`);
    await db.delete(providers).where(sql`id LIKE 'funnel500-p%'`);
  });
});

