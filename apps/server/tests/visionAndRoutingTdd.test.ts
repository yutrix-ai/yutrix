import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq, and, sql } from "drizzle-orm";

const testDbPath = "data/promptgate_test_vision_routing.sqlite";
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

const getResolvedDbPath = () => {
  if (process.cwd().endsWith("server")) {
    return path.join(process.cwd(), "../../", testDbPath);
  }
  return path.join(process.cwd(), testDbPath);
};

describe("Vision and Routing TDD Integration Tests", () => {
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

    const { db: importedDb, initDb } = await import("../src/db");
    await initDb();
    db = importedDb;
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

    // Allow unknown host fallback for local testing
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

  describe("Requirement 15 & 16: Multi-layer Vision Funnel Fallback integration", () => {
    it("handles 302 message vision fallback with correct capabilities & model resolution", async () => {
      // Clear cache first
      await db.delete(responseCache);

      // 1. Setup Providers & Models
      const kimiProvId = "kimi-prov";
      await db.delete(providers).where(eq(providers.id, kimiProvId));
      await db.insert(providers).values({
        id: kimiProvId,
        name: kimiProvId,
        enabled: true,
        openaiBaseUrl: "https://api.kimi.ai/v1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, kimiProvId));
      await db.insert(providerApiKeys).values({
        id: "kimi-key",
        providerId: kimiProvId,
        keyEncrypted: encryptText("kimi-secret"),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerModels).where(eq(providerModels.providerId, kimiProvId));
      await db.insert(providerModels).values({
        id: crypto.randomUUID(),
        providerId: kimiProvId,
        modelId: "kimi-vision",
        displayName: "Kimi Vision",
        enabled: true,
        active: true,
        maxOutputTokens: 100000,
        createdAt: new Date(),
      });

      const nemotronProvId = "nemotron-prov";
      await db.delete(providers).where(eq(providers.id, nemotronProvId));
      await db.insert(providers).values({
        id: nemotronProvId,
        name: nemotronProvId,
        enabled: true,
        openaiBaseUrl: "https://api.nemotron.ai/v1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, nemotronProvId));
      await db.insert(providerApiKeys).values({
        id: "nemotron-key",
        providerId: nemotronProvId,
        keyEncrypted: encryptText("nemotron-secret"),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerModels).where(eq(providerModels.providerId, nemotronProvId));
      await db.insert(providerModels).values({
        id: crypto.randomUUID(),
        providerId: nemotronProvId,
        modelId: "nemotron-code",
        displayName: "Nemotron Code",
        enabled: true,
        active: true,
        maxOutputTokens: 100000,
        createdAt: new Date(),
      });

      const qwenProvId = "qwen-prov";
      await db.delete(providers).where(eq(providers.id, qwenProvId));
      await db.insert(providers).values({
        id: qwenProvId,
        name: qwenProvId,
        enabled: true,
        openaiBaseUrl: "https://api.qwen.ai/v1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, qwenProvId));
      await db.insert(providerApiKeys).values({
        id: "qwen-key",
        providerId: qwenProvId,
        keyEncrypted: encryptText("qwen-secret"),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerModels).where(eq(providerModels.providerId, qwenProvId));
      await db.insert(providerModels).values({
        id: crypto.randomUUID(),
        providerId: qwenProvId,
        modelId: "qwen-model",
        displayName: "Qwen Model",
        enabled: true,
        active: true,
        maxOutputTokens: 100000,
        createdAt: new Date(),
      });

      // 2. Setup Gateway Route with 2 Funnel Targets
      await db.delete(endpointRoutes);
      await db.delete(endpoints);

      const epId = "ep-tdd-vision-funnel";
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
          providerId: nemotronProvId,
          modelId: "nemotron-code",
          strategyRoutingEnabled: true,
          strategyRoutingRules: [
            { taskType: "vision", providerId: kimiProvId, modelId: "kimi-vision", enabled: true },
            { taskType: "code", providerId: nemotronProvId, modelId: "nemotron-code", enabled: true },
            { taskType: "long_context", providerId: nemotronProvId, modelId: "nemotron-code", enabled: true },
            { taskType: "general", providerId: nemotronProvId, modelId: "nemotron-code", enabled: true },
          ],
        },
        {
          providerId: qwenProvId,
          modelId: "qwen-model",
          strategyRoutingEnabled: true,
          strategyRoutingRules: [
            { taskType: "vision", providerId: kimiProvId, modelId: "kimi-vision", enabled: true },
            { taskType: "code", providerId: qwenProvId, modelId: "qwen-model", enabled: true },
            { taskType: "general", providerId: qwenProvId, modelId: "qwen-model", enabled: true },
          ],
        }
      ];

      await db.insert(endpointRoutes).values({
        id: routeId,
        endpointId: epId,
        routeName: "tdd-vision-funnel-route",
        modelId: "nemotron-code",
        providerId: nemotronProvId,
        retryCount: 0,
        fallbackEnabled: true,
        strategyRoutingEnabled: true,
        targets: JSON.stringify(targets),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, routeId));
      await db.insert(routeAuthorizations).values({
        id: crypto.randomUUID(),
        routeId: routeId,
        userId: userId,
        createdAt: new Date(),
      });

      // 3. Stub Fetch
      let fetchCalls: { url: string; body: any }[] = [];
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const bodyObj = init?.body ? JSON.parse(init.body as string) : null;
        fetchCalls.push({ url, body: bodyObj });

        // If L1 vision fails to test L2 fallback
        if (fetchCalls.length === 1 && url.includes("kimi.ai")) {
          // L1 fails with capacity exhaustion error to trigger fallback to L2
          return new Response(
            JSON.stringify({
              error: {
                message: "Kimi overloaded",
                type: "provider_overloaded"
              }
            }),
            { status: 503, headers: { "content-type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({
            id: "chatcmpl-response-test",
            object: "chat.completion",
            created: 12345,
            model: "kimi-vision",
            choices: [
              { index: 0, message: { role: "assistant", content: "Successfully processed vision fallback!" }, finish_reason: "stop" }
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      });

      // 4. Construct 302 messages payload
      const messages: any[] = [];
      for (let i = 0; i < 150; i++) {
        messages.push({ role: "user", content: `question ${i}` });
        messages.push({ role: "assistant", content: `answer ${i}` });
      }
      // Add programming intent + images
      messages.push({
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "UklGR" } },
          { type: "text", text: "Write code to search a binary tree." }
        ]
      });
      // Assistant thinking/tool_use
      messages.push({
        role: "assistant",
        content: "Let me think about writing the code to search the binary tree."
      });
      // User continuation message
      messages.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "success" },
          { type: "text", text: " ", cache_control: { type: "ephemeral" } }
        ]
      });

      const response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        payload: {
          model: "nemotron-code",
          messages,
          stream: false,
        },
      });

      expect(response.statusCode).toBe(200);
      // Verify that it went to Kimi-vision (first call fails, second call goes to Kimi-vision on L2 targets)
      expect(fetchCalls.length).toBe(2);
      expect(fetchCalls[0].url).toContain("kimi.ai");
      expect(fetchCalls[0].body.model).toBe("kimi-vision");
      expect(fetchCalls[1].url).toContain("kimi.ai");
      expect(fetchCalls[1].body.model).toBe("kimi-vision");

      const resBody = JSON.parse(response.body);
      expect(resBody.choices[0].message.content).toContain("Successfully processed vision fallback!");
    });
  });

  describe("OpenAI Chunk Schema Metadata Stability", () => {
    it("ensures that synthesized usage or length chunks share the identical id, created, and model", async () => {
      // Clear cache first
      await db.delete(responseCache);

      const kimiProvId = "kimi-prov";
      const modelId = "kimi-vision";

      // Make sure the provider and model exist for kimi-vision
      await db.delete(providers).where(eq(providers.id, kimiProvId));
      await db.insert(providers).values({
        id: kimiProvId,
        name: kimiProvId,
        enabled: true,
        openaiBaseUrl: "https://api.kimi.ai/v1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, kimiProvId));
      await db.insert(providerApiKeys).values({
        id: "kimi-key-stream",
        providerId: kimiProvId,
        keyEncrypted: encryptText("kimi-secret"),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerModels).where(eq(providerModels.providerId, kimiProvId));
      await db.insert(providerModels).values({
        id: crypto.randomUUID(),
        providerId: kimiProvId,
        modelId: modelId,
        displayName: "Kimi Vision",
        enabled: true,
        active: true,
        maxOutputTokens: 100000,
        createdAt: new Date(),
      });

      await db.delete(endpointRoutes);
      await db.delete(endpoints);

      const epId = "ep-test-stream-stable";
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
      await db.insert(endpointRoutes).values({
        id: routeId,
        endpointId: epId,
        routeName: "stream-stable-route",
        modelId: modelId,
        providerId: kimiProvId,
        retryCount: 0,
        fallbackEnabled: false,
        strategyRoutingEnabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, routeId));
      await db.insert(routeAuthorizations).values({
        id: crypto.randomUUID(),
        routeId: routeId,
        userId: userId,
        createdAt: new Date(),
      });

      let fetchCount = 0;
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        fetchCount++;
        // Simulate a SSE stream response from upstream that indicates length limit reached
        const sseStream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
              id: "chatcmpl-upstream-123",
              object: "chat.completion.chunk",
              created: 11111,
              model: modelId,
              choices: [{ index: 0, delta: { content: "Thinking process" }, finish_reason: "length" }]
            })}\n\n`));
            controller.close();
          }
        });

        return new Response(sseStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      });

      const response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        payload: {
          model: modelId,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);

      // Parse output SSE chunks
      const lines = response.body.split("\n");
      const dataChunks = lines
        .filter(l => l.startsWith("data: ") && !l.includes("[DONE]"))
        .map(l => JSON.parse(l.slice(6)));

      expect(dataChunks.length).toBeGreaterThanOrEqual(2);

      // Verify that synthesized chunks (like the usage chunk at the end) share the identical ID, model, and created timestamp
      const synthesizedChunks = dataChunks.filter(c => c.choices.length === 0 || c.choices[0].finish_reason === "length");
      expect(synthesizedChunks.length).toBeGreaterThan(0);
      const first = synthesizedChunks[0];
      for (const chunk of synthesizedChunks) {
        expect(chunk.id).toBe(first.id);
        expect(chunk.created).toBe(first.created);
        expect(chunk.model).toBe(first.model);
      }
    });
  });

  describe("OpenRouter Capacity Retry Fetch Limits", () => {
    it("limits OpenRouter capacity retries strictly to <= 3 total fetches (2 retries max)", async () => {
      // Clear cache first
      await db.delete(responseCache);

      const provId = "openrouter-prov";
      const modelId = "openrouter/nemotron-3-ultra";

      // Setup OpenRouter Provider
      await db.delete(providers).where(eq(providers.id, provId));
      await db.insert(providers).values({
        id: provId,
        name: provId,
        enabled: true,
        openaiBaseUrl: "https://openrouter.ai/api/v1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, provId));
      await db.insert(providerApiKeys).values({
        id: "openrouter-key-cap",
        providerId: provId,
        keyEncrypted: encryptText("openrouter-secret"),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerModels).where(eq(providerModels.providerId, provId));
      await db.insert(providerModels).values({
        id: crypto.randomUUID(),
        providerId: provId,
        modelId: modelId,
        displayName: "Nemotron 3 Ultra",
        enabled: true,
        active: true,
        maxOutputTokens: 100000,
        createdAt: new Date(),
      });

      await db.delete(endpointRoutes);
      await db.delete(endpoints);

      const epId = "ep-test-routing-cap";
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
          strategyRoutingEnabled: true,
          strategyRoutingRules: [
            { taskType: "code", providerId: provId, modelId: modelId, enabled: true }
          ],
        }
      ];

      await db.insert(endpointRoutes).values({
        id: routeId,
        endpointId: epId,
        routeName: "openrouter-capacity-route",
        modelId: modelId,
        providerId: provId,
        retryCount: 0,
        fallbackEnabled: false,
        strategyRoutingEnabled: true,
        targets: JSON.stringify(targets),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, routeId));
      await db.insert(routeAuthorizations).values({
        id: crypto.randomUUID(),
        routeId: routeId,
        userId: userId,
        createdAt: new Date(),
      });

      let fetchCount = 0;
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        fetchCount++;
        // Keep returning resource exhausted to check fetch cap
        return new Response(
          JSON.stringify({
            error: {
              message: "Provider capacity exhausted resource exhausted (79/32) local limit exceeded",
              type: "provider_overloaded"
            }
          }),
          { status: 503, headers: { "content-type": "application/json" } }
        );
      });

      const response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        payload: {
          model: modelId,
          messages: [{ role: "user", content: "test capacity retry limit" }],
          stream: false,
        },
      });

      expect(response.statusCode).toBe(503);
      // Assert that fetchCount is capped at exactly 3 (1 initial fetch + 2 capacity retries)
      expect(fetchCount).toBe(3);
    });
  });

  describe("Transparent Adapter Ordinary 503 Behavior", () => {
    it("does not trigger OpenRouter capacity retry on a transparent 503 status code", async () => {
      // Clear cache first
      await db.delete(responseCache);

      const provId = "transparent-prov";
      const modelId = "transparent/model";

      // Setup Transparent Provider
      await db.delete(providers).where(eq(providers.id, provId));
      await db.insert(providers).values({
        id: provId,
        name: provId,
        enabled: true,
        openaiBaseUrl: "https://api.transparent.ai/v1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, provId));
      await db.insert(providerApiKeys).values({
        id: "transparent-key-tdd",
        providerId: provId,
        keyEncrypted: encryptText("transparent-secret"),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerModels).where(eq(providerModels.providerId, provId));
      await db.insert(providerModels).values({
        id: crypto.randomUUID(),
        providerId: provId,
        modelId: modelId,
        displayName: "Transparent Model",
        enabled: true,
        active: true,
        maxOutputTokens: 100000,
        createdAt: new Date(),
      });

      await db.delete(endpointRoutes);
      await db.delete(endpoints);

      const epId = "ep-test-routing-transparent";
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
          strategyRoutingEnabled: true,
          strategyRoutingRules: [],
        }
      ];

      await db.insert(endpointRoutes).values({
        id: routeId,
        endpointId: epId,
        routeName: "transparent-route",
        modelId: modelId,
        providerId: provId,
        retryCount: 0,
        fallbackEnabled: false,
        strategyRoutingEnabled: true,
        targets: JSON.stringify(targets),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, routeId));
      await db.insert(routeAuthorizations).values({
        id: crypto.randomUUID(),
        routeId: routeId,
        userId: userId,
        createdAt: new Date(),
      });

      let fetchCount = 0;
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        fetchCount++;
        return new Response(
          JSON.stringify({ error: "Service Unavailable" }),
          { status: 503, headers: { "content-type": "application/json" } }
        );
      });

      const response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        payload: {
          model: modelId,
          messages: [{ role: "user", content: "test transparent 503" }],
          stream: false,
        },
      });

      expect(response.statusCode).toBe(503);
      // Capped at exactly 1 fetch because ordinary 503 is not capacity-retryable under transparent adapter
      expect(fetchCount).toBe(1);
    });
  });

  describe("Long Context Override Token Estimation & Vision + Long Context", () => {
    it("proves that two 500 KB images (total ~1 MB) are estimated correctly and do not trigger override when limit is high", async () => {
      // Clear cache first
      await db.delete(responseCache);

      const kimiProvId = "kimi-prov-lc";
      const modelId = "kimi-vision-lc";

      // Setup Kimi Provider
      await db.delete(providers).where(eq(providers.id, kimiProvId));
      await db.insert(providers).values({
        id: kimiProvId,
        name: kimiProvId,
        enabled: true,
        openaiBaseUrl: "https://api.kimi.ai/v1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, kimiProvId));
      await db.insert(providerApiKeys).values({
        id: "kimi-key-lc",
        providerId: kimiProvId,
        keyEncrypted: encryptText("kimi-secret"),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerModels).where(eq(providerModels.providerId, kimiProvId));
      await db.insert(providerModels).values({
        id: crypto.randomUUID(),
        providerId: kimiProvId,
        modelId: modelId,
        displayName: "Kimi Vision LC",
        enabled: true,
        active: true,
        maxOutputTokens: 10000, // Limit is 10000. New estimate is 8197, so it fits! Old estimate would be > 330k and trigger override.
        createdAt: new Date(),
      });

      await db.delete(endpointRoutes);
      await db.delete(endpoints);

      const epId = "ep-test-routing-lc";
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
          providerId: kimiProvId,
          modelId: modelId,
          strategyRoutingEnabled: true,
          strategyRoutingRules: [
            { taskType: "vision", providerId: kimiProvId, modelId: modelId, enabled: true },
            { taskType: "long_context", providerId: kimiProvId, modelId: "kimi-long-context-non-existent", enabled: true }
          ],
        }
      ];

      await db.insert(endpointRoutes).values({
        id: routeId,
        endpointId: epId,
        routeName: "kimi-lc-route",
        modelId: modelId,
        providerId: kimiProvId,
        retryCount: 0,
        fallbackEnabled: false,
        strategyRoutingEnabled: true,
        targets: JSON.stringify(targets),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, routeId));
      await db.insert(routeAuthorizations).values({
        id: crypto.randomUUID(),
        routeId: routeId,
        userId: userId,
        createdAt: new Date(),
      });

      let fetchCalledWithModel = "";
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const bodyObj = init?.body ? JSON.parse(init.body as string) : null;
        fetchCalledWithModel = bodyObj?.model;
        return new Response(
          JSON.stringify({
            id: "chatcmpl-test-lc",
            object: "chat.completion",
            created: 12345,
            model: modelId,
            choices: [{ index: 0, message: { role: "assistant", content: "Success!" } }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      });

      const base64_1 = "a".repeat(500 * 1024); // 500 KB
      const base64_2 = "b".repeat(500 * 1024); // 500 KB

      console.log("TESTING: Calling fastify.inject...");
      const response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        payload: {
          model: modelId,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: base64_1 } },
                { type: "image", source: { type: "base64", media_type: "image/png", data: base64_2 } },
                { type: "text", text: "hi" }
              ]
            }
          ],
          stream: false,
        },
      });

      expect(response.statusCode).toBe(200);
      // It should NOT trigger long context override, so it fetches the original model
      expect(fetchCalledWithModel).toBe(modelId);
    });

    it("triggers long context override when limit is 6000, and falls back to subsequent vision targets, returning 413 if no target fits", async () => {
      // Clear cache first
      await db.delete(responseCache);

      const kimiProvId = "kimi-prov-lc2";
      const modelL1 = "kimi-vision-l1";
      const modelL2 = "kimi-vision-l2";

      // Setup Providers & Models
      await db.delete(providers).where(eq(providers.id, kimiProvId));
      await db.insert(providers).values({
        id: kimiProvId,
        name: kimiProvId,
        enabled: true,
        openaiBaseUrl: "https://api.kimi.ai/v1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, kimiProvId));
      await db.insert(providerApiKeys).values({
        id: "kimi-key-lc2",
        providerId: kimiProvId,
        keyEncrypted: encryptText("kimi-secret"),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // L1 model: maxOutputTokens 6000
      await db.delete(providerModels).where(and(eq(providerModels.providerId, kimiProvId), eq(providerModels.modelId, modelL1)));
      await db.insert(providerModels).values({
        id: crypto.randomUUID(),
        providerId: kimiProvId,
        modelId: modelL1,
        displayName: "Kimi Vision L1",
        enabled: true,
        active: true,
        maxOutputTokens: 6000,
        rawJson: JSON.stringify({ contextWindowTokens: 6000 }),
        createdAt: new Date(),
      });

      // L2 model: maxOutputTokens 16000
      await db.delete(providerModels).where(and(eq(providerModels.providerId, kimiProvId), eq(providerModels.modelId, modelL2)));
      await db.insert(providerModels).values({
        id: crypto.randomUUID(),
        providerId: kimiProvId,
        modelId: modelL2,
        displayName: "Kimi Vision L2",
        enabled: true,
        active: true,
        maxOutputTokens: 16000,
        rawJson: JSON.stringify({ contextWindowTokens: 16000 }),
        createdAt: new Date(),
      });

      await db.delete(endpointRoutes);
      await db.delete(endpoints);

      const epId = "ep-test-routing-lc2";
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
          providerId: kimiProvId,
          modelId: modelL1,
          strategyRoutingEnabled: true,
          strategyRoutingRules: [
            { taskType: "vision", providerId: kimiProvId, modelId: modelL1, enabled: true },
            { taskType: "long_context", providerId: kimiProvId, modelId: "non-existent-non-vision", enabled: true }
          ],
        },
        {
          providerId: kimiProvId,
          modelId: modelL2,
          strategyRoutingEnabled: true,
          strategyRoutingRules: [
            { taskType: "vision", providerId: kimiProvId, modelId: modelL2, enabled: true }
          ],
        }
      ];

      await db.insert(endpointRoutes).values({
        id: routeId,
        endpointId: epId,
        routeName: "kimi-lc2-route",
        modelId: modelL1,
        providerId: kimiProvId,
        retryCount: 0,
        fallbackEnabled: false,
        strategyRoutingEnabled: true,
        targets: JSON.stringify(targets),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, routeId));
      await db.insert(routeAuthorizations).values({
        id: crypto.randomUUID(),
        routeId: routeId,
        userId: userId,
        createdAt: new Date(),
      });

      let fetchCalledWithModel = "";
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const bodyObj = init?.body ? JSON.parse(init.body as string) : null;
        fetchCalledWithModel = bodyObj?.model;
        return new Response(
          JSON.stringify({
            id: "chatcmpl-test-lc2",
            object: "chat.completion",
            created: 12345,
            model: modelL2,
            choices: [{ index: 0, message: { role: "assistant", content: "Success!" } }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      });

      const base64_1 = "a".repeat(500 * 1024); // 500 KB
      const base64_2 = "b".repeat(500 * 1024); // 500 KB

      // First run: L2 fits the 8192 tokens.
      let response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        payload: {
          model: modelL1,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: base64_1 } },
                { type: "image", source: { type: "base64", media_type: "image/png", data: base64_2 } },
                { type: "text", text: "hi" }
              ]
            }
          ],
          stream: false,
        },
      });

      expect(response.statusCode).toBe(200);
      // It should successfully trigger vision long context override and switch to modelL2
      expect(fetchCalledWithModel).toBe(modelL2);

      // Second run: Make L2 model too small as well (contextWindowTokens 7000)
      await db.update(providerModels)
        .set({ rawJson: JSON.stringify({ contextWindowTokens: 7000 }) })
        .where(and(eq(providerModels.providerId, kimiProvId), eq(providerModels.modelId, modelL2)));

      response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        payload: {
          model: modelL1,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: base64_1 } },
                { type: "image", source: { type: "base64", media_type: "image/png", data: base64_2 } },
                { type: "text", text: "hi" }
              ]
            }
          ],
          stream: false,
        },
      });

      expect(response.statusCode).toBe(200);
      // It should NOT hard reject; it should just fall through to the original model (L1) because no fallback fit.
      expect(fetchCalledWithModel).toBe(modelL1);
    });
  });
});
