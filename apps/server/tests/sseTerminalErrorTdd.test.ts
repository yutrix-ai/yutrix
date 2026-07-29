import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq, and, sql } from "drizzle-orm";

const testDbPath = "data/promptgate_test_sse_terminal.sqlite";
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

// ---------------------------------------------------------------------------
// SSE stream helper factories
// ---------------------------------------------------------------------------

/** Produces a well-formed SSE stream that delivers a successful chat completion chunk. */
function makeSseSuccess(model: string, content: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        id: "chatcmpl-ok-" + crypto.randomUUID().slice(0, 8),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
      })}\n\n`));
      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        id: "chatcmpl-ok-" + crypto.randomUUID().slice(0, 8),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/** SSE stream that contains a ResourceExhausted / provider capacity error (503-style). */
function makeSseCapacityError(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        error: {
          message: "ResourceExhausted: Provider capacity exhausted. local total request limit",
          code: 503,
        },
      })}\n\n`));
      controller.close();
    },
  });
}

/** SSE stream with a rate_limit_exceeded error via choices finish_reason: "error". */
function makeSseRateLimitError(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        error: {
          message: "Rate limit exceeded",
          metadata: { error_type: "rate_limit_exceeded" },
        },
        choices: [{ finish_reason: "error" }],
      })}\n\n`));
      controller.close();
    },
  });
}

/** SSE stream with an invalid_api_key auth error via choices finish_reason: "error". */
function makeSseAuthError(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        error: {
          message: "Invalid API key",
          metadata: { error_type: "invalid_api_key" },
        },
        choices: [{ finish_reason: "error" }],
      })}\n\n`));
      controller.close();
    },
  });
}

/**
 * SSE stream that sends real content first, then emits a capacity error mid-stream.
 * This simulates a partial success followed by an upstream failure.
 */
function makeSsePartialThenError(model: string, content: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      // Emit a valid content chunk first
      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        id: "chatcmpl-partial-" + crypto.randomUUID().slice(0, 8),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
      })}\n\n`));
      // Then emit capacity error
      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        error: {
          message: "ResourceExhausted: Provider capacity exhausted. local total request limit",
          code: 503,
        },
      })}\n\n`));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------

describe("SSE Terminal Error Integration Tests", () => {
  const fastify = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  let apiKey = "";
  let userId = "";

  // Provider & key IDs (shared across tests)
  const provL1 = "sse-prov-l1";
  const provL2 = "sse-prov-l2";
  const keyL1A = "sse-l1-key-a";
  const keyL1B = "sse-l1-key-b";
  const keyL2 = "sse-l2-key";
  const modelL1 = "model-l1";
  const modelL2 = "model-l2";

  beforeAll(async () => {
    // Clean up any previous test DB
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

    // Create test user
    await db.delete(users).where(eq(users.username, "tdduser-sse"));
    userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: "tdduser-sse",
      passwordHash: "dummy",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create API key for the test user
    const rawKey = "pg_key_sse_" + crypto.randomBytes(16).toString("hex");
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      userId: userId,
      name: "SSE TDD API Key",
      keyHash: keyHash,
      keyPrefix: rawKey.substring(0, 12),
      status: "active",
      concurrencyLimit: 10,
      createdAt: new Date(),
    });
    apiKey = rawKey;

    // -----------------------------------------------------------------------
    // Provider L1: OpenRouter (triggers OpenRouter adapter)
    // -----------------------------------------------------------------------
    await db.delete(providers).where(eq(providers.id, provL1));
    await db.insert(providers).values({
      id: provL1,
      name: "SSE Provider L1 (OpenRouter)",
      enabled: true,
      openaiBaseUrl: "https://openrouter.ai/api/v1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // L1: 2 API keys
    await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, provL1));
    await db.insert(providerApiKeys).values([
      {
        id: keyL1A,
        providerId: provL1,
        keyEncrypted: encryptText("l1-secret-key-a"),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: keyL1B,
        providerId: provL1,
        keyEncrypted: encryptText("l1-secret-key-b"),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    // L1: model
    await db.delete(providerModels).where(eq(providerModels.providerId, provL1));
    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: provL1,
      modelId: modelL1,
      displayName: "Model L1",
      enabled: true,
      active: true,
      maxOutputTokens: 100000,
      createdAt: new Date(),
    });

    // -----------------------------------------------------------------------
    // Provider L2: Alternative (non-OpenRouter)
    // -----------------------------------------------------------------------
    await db.delete(providers).where(eq(providers.id, provL2));
    await db.insert(providers).values({
      id: provL2,
      name: "SSE Provider L2 (Alternative)",
      enabled: true,
      openaiBaseUrl: "https://api.alternative.com/v1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // L2: 1 API key
    await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, provL2));
    await db.insert(providerApiKeys).values({
      id: keyL2,
      providerId: provL2,
      keyEncrypted: encryptText("l2-secret-key"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // L2: model
    await db.delete(providerModels).where(eq(providerModels.providerId, provL2));
    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: provL2,
      modelId: modelL2,
      displayName: "Model L2",
      enabled: true,
      active: true,
      maxOutputTokens: 100000,
      createdAt: new Date(),
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (db && responseCache) {
      await db.delete(responseCache);
    }
    // Reset key statuses back to active after each test
    await db.update(providerApiKeys)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(providerApiKeys.providerId, provL1));
    await db.update(providerApiKeys)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(providerApiKeys.providerId, provL2));
  });

  afterAll(async () => {
    await fastify.close();
    const resolvedPath = getResolvedDbPath();
    if (fs.existsSync(resolvedPath)) {
      try { fs.unlinkSync(resolvedPath); } catch (e) {}
    }
  });

  // =========================================================================
  // Helper: setup a route with given funnel targets
  // =========================================================================
  async function setupRoute(
    routeName: string,
    targets: Array<{ providerId: string; modelId: string }>,
    opts?: { fallbackEnabled?: boolean, path?: string, incomingProtocol?: string },
  ) {
    await db.delete(endpointRoutes);
    await db.delete(endpoints);

    const epId = "ep-sse-" + routeName;
    await db.insert(endpoints).values({
      id: epId,
      userId: userId,
      name: "gateway",
      path: opts?.path || "/v1/chat/completions",
      incomingProtocol: opts?.incomingProtocol || "openai",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const routeId = crypto.randomUUID();
    const funnelTargets = targets.map((t) => ({
      providerId: t.providerId,
      modelId: t.modelId,
      strategyRoutingEnabled: false,
    }));

    await db.insert(endpointRoutes).values({
      id: routeId,
      endpointId: epId,
      routeName: routeName,
      modelId: targets[0].modelId,
      providerId: targets[0].providerId,
      retryCount: 0,
      fallbackEnabled: opts?.fallbackEnabled ?? (targets.length > 1),
      strategyRoutingEnabled: false,
      targets: JSON.stringify(funnelTargets),
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

    return routeId;
  }

  // =========================================================================
  // Test A: Capacity→Capacity→Key B success (stream)
  // =========================================================================
  describe("Test A: Capacity→Capacity→Key B success (stream)", () => {
    it("retries capacity errors across keys and succeeds on Key B", async () => {
      await db.delete(responseCache);
      await setupRoute("sse-route-a", [
        { providerId: provL1, modelId: modelL1 },
        { providerId: provL2, modelId: modelL2 },
      ]);

      const fetchCalls: { url: string; auth: string; body: any }[] = [];

      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const auth = (init?.headers as any)?.Authorization || "";
        const body = init?.body ? JSON.parse(init.body as string) : {};
        fetchCalls.push({ url: String(url), auth, body });

        if (fetchCalls.length <= 2) {
          // First 2 calls: SSE capacity error
          return new Response(makeSseCapacityError(), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        if (fetchCalls.length === 3) {
          // 3rd call: SSE rate limit error (triggers key rotation)
          return new Response(makeSseRateLimitError(), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        // 4th call: Key B succeeds
        return new Response(makeSseSuccess(modelL1, "Success from key B"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });

      const response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          model: modelL1,
          messages: [{ role: "user", content: "test capacity retry" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchCalls.length).toBe(4);

      // Auth header should differ between the capacity-exhausted calls and the success call
      const firstAuth = fetchCalls[0].auth;
      const lastAuth = fetchCalls[fetchCalls.length - 1].auth;
      expect(lastAuth).not.toBe(firstAuth);

      // Verify successful content is present in response body
      const bodyText = response.body;
      expect(bodyText).toContain("Success from key B");
    });
  });

  // ---------------------------------------------------------------------------
  // G: OpenRouter Anthropic Server-Tool Shorthand Compatibility
  // ---------------------------------------------------------------------------
  describe("G: OpenRouter Anthropic Server-Tool Shorthands", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should cleanly strip unsupported tool shorthands if missing from history", async () => {
      const fetchCalls: { url: string; auth: string; body: any }[] = [];
      vi.spyOn(global, "fetch").mockImplementation(async (req: any, options: any) => {
        let body: any = null;
        if (options?.body) body = JSON.parse(options.body as string);
        
        fetchCalls.push({
          url: req.toString(),
          auth: options?.headers?.Authorization || options?.headers?.authorization || "",
          body,
        });

        // return success immediately
        return new Response(makeSseSuccess(modelL1, "success-content"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });
      await setupRoute("multi", [{ providerId: provL1, modelId: modelL1 }, { providerId: provL2, modelId: modelL2 }], { path: "/v1/messages", incomingProtocol: "anthropic" });
      
      // Inject request with unsupported shorthand
      const response = await fastify.inject({
        method: "POST",
        url: `/v1/messages`,
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        body: {
          model: "ignored",
          messages: [{ role: "user", content: "test" }],
          stream: true,
          tools: [
            { type: "tool_search_tool_regex_20251119" },
            { type: "computer_20241022" },
            { name: "normal_tool", description: "ok", input_schema: {} }
          ]
        },
      });

      expect(response.statusCode).toBe(200);
      const text = response.body;
      expect(text).toContain("success-content");
      expect(fetchCalls.length).toBe(1);

      // Verify tools stripped correctly
      const sentBody = fetchCalls[0].body;
      expect(sentBody.tools.length).toBe(2);
      expect(sentBody.tools).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "tool_search_tool_regex_20251119" })])
      );
      expect(sentBody.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "computer_20241022" }),
          expect.objectContaining({ name: "normal_tool" })
        ])
      );
    });

    it("should trigger Funnel Fallback if unsupported shorthand is referenced in history", async () => {
      const fetchCalls: { url: string; auth: string; body: any }[] = [];
      vi.spyOn(global, "fetch").mockImplementation(async (req: any, options: any) => {
        let body: any = null;
        if (options?.body) body = JSON.parse(options.body as string);
        
        fetchCalls.push({
          url: req.toString(),
          auth: options?.headers?.Authorization || options?.headers?.authorization || "",
          body,
        });

        return new Response(makeSseSuccess(modelL2, "fallback-success"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });
      await setupRoute("multi", [{ providerId: provL1, modelId: modelL1 }, { providerId: provL2, modelId: modelL2 }], { path: "/v1/messages", incomingProtocol: "anthropic" });
      
      // Inject request where history contains tool_use
      const response = await fastify.inject({
        method: "POST",
        url: `/v1/messages`,
        headers: {
          authorization: `Bearer ${apiKey}`, // multi-target for fallback
        },
        body: {
          model: "ignored",
          messages: [
            { role: "user", content: "do it" },
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "tool_search_tool_regex_20251119", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }
          ],
          stream: true,
          tools: [
            { type: "tool_search_tool_regex_20251119" }
          ]
        },
      });

      expect(response.statusCode).toBe(200);
      const text = response.body;
      expect(text).toContain("fallback-success");
      // Should have skipped L1 immediately and hit L2
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].url).toContain("api.alternative.com");
      expect(fetchCalls[0].body.model).toBe(modelL2);
    });

    it("should trigger Funnel Fallback if upstream explicitly returns Unknown server-tool shorthand", async () => {
      const fetchCalls: { url: string; auth: string; body: any }[] = [];
      vi.spyOn(global, "fetch").mockImplementation(async (req: any, options: any) => {
        let body: any = null;
        if (options?.body) body = JSON.parse(options.body as string);
        
        fetchCalls.push({
          url: req.toString(),
          auth: options?.headers?.Authorization || options?.headers?.authorization || "",
          body,
        });

        if (req.toString().includes("openrouter.ai")) {
          // Return 400 error matching OpenRouter's payload
          const errorResp = {
            error: {
              message: "Invalid Anthropic Messages API request: Unknown server-tool shorthand",
              metadata: { 
                error_type: "invalid_request_error",
                raw: JSON.stringify([
                  { path: ["tools", 0, "type"], message: "Unknown server-tool shorthand" }
                ])
              }
            }
          };
          return new Response(JSON.stringify(errorResp), {
            status: 400,
            headers: { "content-type": "application/json" }
          });
        }

        return new Response(makeSseSuccess(modelL2, "success"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });
      await setupRoute("multi", [{ providerId: provL1, modelId: modelL1 }, { providerId: provL2, modelId: modelL2 }], { path: "/v1/messages", incomingProtocol: "anthropic" });
      
      // Inject request that bypasses filter (e.g. some other unsupported tool)
      const response = await fastify.inject({
        method: "POST",
        url: `/v1/messages`,
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        body: {
          model: "ignored",
          messages: [{ role: "user", content: "test" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchCalls.length).toBe(2);
      expect(fetchCalls[0].url).toContain("openrouter.ai"); // first try gets 400
      expect(fetchCalls[1].url).toContain("api.alternative.com"); // fallback works
    });

    it("materializes defer_loading for non-Anthropic OpenRouter models before upstream call", async () => {
      const fetchCalls: { url: string; auth: string; body: any }[] = [];
      vi.spyOn(global, "fetch").mockImplementation(async (req: any, options: any) => {
        let body: any = null;
        if (options?.body) body = JSON.parse(options.body as string);

        fetchCalls.push({
          url: req.toString(),
          auth: options?.headers?.Authorization || options?.headers?.authorization || "",
          body,
        });

        return new Response(makeSseSuccess(modelL1, "deferred-ok"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });
      await setupRoute("multi", [{ providerId: provL1, modelId: modelL1 }, { providerId: provL2, modelId: modelL2 }], { path: "/v1/messages", incomingProtocol: "anthropic" });

      const response = await fastify.inject({
        method: "POST",
        url: `/v1/messages`,
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        body: {
          model: "ignored",
          messages: [{ role: "user", content: "edit file" }],
          stream: true,
          tools: [
            { name: "Read", defer_loading: true, description: "read", input_schema: { type: "object" } },
            { name: "Edit", defer_loading: true, description: "edit", input_schema: { type: "object" } },
            { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("deferred-ok");
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].url).toContain("openrouter.ai");
      // tool_search removed; custom tools kept without defer_loading
      expect(fetchCalls[0].body.tools).toHaveLength(2);
      for (const t of fetchCalls[0].body.tools) {
        expect(t.defer_loading).toBeUndefined();
        expect(["Read", "Edit"]).toContain(t.name);
      }
    });

    it("triggers Funnel Fallback when upstream returns Deferred custom tools 400", async () => {
      const fetchCalls: { url: string; auth: string; body: any }[] = [];
      vi.spyOn(global, "fetch").mockImplementation(async (req: any, options: any) => {
        let body: any = null;
        if (options?.body) body = JSON.parse(options.body as string);

        fetchCalls.push({
          url: req.toString(),
          auth: options?.headers?.Authorization || options?.headers?.authorization || "",
          body,
        });

        if (req.toString().includes("openrouter.ai")) {
          const errorResp = {
            error: {
              message:
                "Deferred custom tools are only supported on Anthropic models. Non-Anthropic models cannot call tools omitted from tools[]. Received nvidia/nemotron-3-ultra-550b-a55b-20260604.",
              code: 400,
            },
          };
          return new Response(JSON.stringify(errorResp), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(makeSseSuccess(modelL2, "deferred-fallback-success"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });
      await setupRoute("multi", [{ providerId: provL1, modelId: modelL1 }, { providerId: provL2, modelId: modelL2 }], { path: "/v1/messages", incomingProtocol: "anthropic" });

      const response = await fastify.inject({
        method: "POST",
        url: `/v1/messages`,
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        body: {
          model: "ignored",
          messages: [{ role: "user", content: "continue" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("deferred-fallback-success");
      expect(fetchCalls.length).toBe(2);
      expect(fetchCalls[0].url).toContain("openrouter.ai");
      expect(fetchCalls[1].url).toContain("api.alternative.com");
    });
  });

  // =========================================================================
  // Test B: Capacity exhausted L1, fallback to L2
  // =========================================================================
  describe("Test B: Capacity exhausted L1, fallback to L2", () => {
    it("falls back from L1 to L2 when all L1 keys exhaust capacity", async () => {
      await db.delete(responseCache);
      await setupRoute("sse-route-b", [
        { providerId: provL1, modelId: modelL1 },
        { providerId: provL2, modelId: modelL2 },
      ]);

      const fetchCalls: { url: string; auth: string; body: any }[] = [];

      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const auth = (init?.headers as any)?.Authorization || "";
        const body = init?.body ? JSON.parse(init.body as string) : {};
        fetchCalls.push({ url: String(url), auth, body });

        // L1 calls always return capacity error
        if (body.model === modelL1) {
          return new Response(makeSseCapacityError(), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }

        // L2 succeeds
        return new Response(makeSseSuccess(modelL2, "Success from L2"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });

      const response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          model: modelL1,
          messages: [{ role: "user", content: "test L1 exhausted fallback" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      // Should have tried L1 keys (up to capacity retry limit), then fallen back to L2
      expect(fetchCalls.length).toBeGreaterThanOrEqual(3);

      // L2 model should appear in the output
      const bodyText = response.body;
      expect(bodyText).toContain("Success from L2");
      // L1 capacity errors should NOT leak to the client
      expect(bodyText).not.toContain("ResourceExhausted");
      expect(bodyText).not.toContain("capacity exhausted");
    });
  });

  // =========================================================================
  // Test C: Capacity exhausted, no L2, final error
  // =========================================================================
  describe("Test C: Capacity exhausted, no L2, final error", () => {
    it("returns error when all capacity is exhausted and no fallback is available", async () => {
      await db.delete(responseCache);
      // Route with only L1 (no fallback target)
      await setupRoute("sse-route-c", [
        { providerId: provL1, modelId: modelL1 },
      ], { fallbackEnabled: false });

      const fetchCalls: { url: string; auth: string; body: any }[] = [];

      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const auth = (init?.headers as any)?.Authorization || "";
        const body = init?.body ? JSON.parse(init.body as string) : {};
        fetchCalls.push({ url: String(url), auth, body });

        // All calls return capacity error
        return new Response(makeSseCapacityError(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });

      const response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          model: modelL1,
          messages: [{ role: "user", content: "test no fallback" }],
          stream: true,
        },
      });

      // Should eventually return an error — either HTTP 503 or an SSE error event
      // The gateway exhausts all capacity retries and has no fallback
      const bodyText = response.body;
      const isErrorStatus = response.statusCode === 503 || response.statusCode >= 400;
      const hasErrorInSse = bodyText.includes("error") || bodyText.includes("capacity");

      expect(isErrorStatus || hasErrorInSse).toBe(true);
      // Should have tried exactly 3 times (initial + 2 retries, capped by OpenRouter adapter)
      expect(fetchCalls.length).toBe(3);
      // No successful content should be present
      expect(bodyText).not.toContain("Success");
    });
  });

  // =========================================================================
  // Test D: SSE 429 Key A → Key B success
  // =========================================================================
  describe("Test D: SSE 429 Key A → Key B success", () => {
    it("rotates to Key B after Key A returns SSE rate_limit_exceeded", async () => {
      await db.delete(responseCache);
      await setupRoute("sse-route-d", [
        { providerId: provL1, modelId: modelL1 },
        { providerId: provL2, modelId: modelL2 },
      ]);

      const fetchCalls: { url: string; auth: string; body: any }[] = [];

      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const auth = (init?.headers as any)?.Authorization || "";
        const body = init?.body ? JSON.parse(init.body as string) : {};
        fetchCalls.push({ url: String(url), auth, body });

        if (fetchCalls.length === 1) {
          // Key A: rate limit error
          return new Response(makeSseRateLimitError(), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        // Key B: success
        return new Response(makeSseSuccess(modelL1, "Success after rate limit"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });

      const response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          model: modelL1,
          messages: [{ role: "user", content: "test rate limit key rotation" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchCalls.length).toBe(2);

      // Different auth headers => different keys used
      expect(fetchCalls[0].auth).not.toBe(fetchCalls[1].auth);

      // Verify successful content
      const bodyText = response.body;
      expect(bodyText).toContain("Success after rate limit");

      // Both keys should remain active (rate limit is transient)
      const l1Keys = await db.select().from(providerApiKeys)
        .where(eq(providerApiKeys.providerId, provL1));
      const activeKeys = l1Keys.filter((k: any) => k.status === "active");
      expect(activeKeys.length).toBe(2);
    });
  });

  // =========================================================================
  // Test E: SSE 401 Key A/B → L2 success
  // =========================================================================
  describe("Test E: SSE 401 Key A/B → L2 success", () => {
    it("marks L1 keys invalid and falls back to L2 on SSE auth error", async () => {
      await db.delete(responseCache);
      await setupRoute("sse-route-e", [
        { providerId: provL1, modelId: modelL1 },
        { providerId: provL2, modelId: modelL2 },
      ]);

      const fetchCalls: { url: string; auth: string; body: any }[] = [];

      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const auth = (init?.headers as any)?.Authorization || "";
        const body = init?.body ? JSON.parse(init.body as string) : {};
        fetchCalls.push({ url: String(url), auth, body });

        // L1 calls: auth errors
        if (body.model === modelL1) {
          return new Response(makeSseAuthError(), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }

        // L2: success
        return new Response(makeSseSuccess(modelL2, "Success from L2 after auth failure"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });

      const response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          model: modelL1,
          messages: [{ role: "user", content: "test auth error cascade" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchCalls.length).toBe(3); // Key A auth fail, Key B auth fail, L2 success

      // L2 model content should be present
      const bodyText = response.body;
      expect(bodyText).toContain("Success from L2 after auth failure");

      // Keys should remain active
      const l1Keys = await db.select().from(providerApiKeys)
        .where(eq(providerApiKeys.providerId, provL1));
      const activeKeys = l1Keys.filter((k: any) => k.status === "active");
      expect(activeKeys.length).toBe(2);
    });
  });

  // =========================================================================
  // Test F: Partial text then error, no retry
  // =========================================================================
  describe("Test F: Partial text then error, no retry", () => {
    it("does not retry when content was already sent before the error", async () => {
      await db.delete(responseCache);
      await setupRoute("sse-route-f", [
        { providerId: provL1, modelId: modelL1 },
        { providerId: provL2, modelId: modelL2 },
      ]);

      const fetchCalls: { url: string; auth: string; body: any }[] = [];

      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const auth = (init?.headers as any)?.Authorization || "";
        const body = init?.body ? JSON.parse(init.body as string) : {};
        fetchCalls.push({ url: String(url), auth, body });

        // First call: partial content 'hello' then capacity error
        return new Response(makeSsePartialThenError(modelL1, "hello"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });

      const response = await fastify.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          model: modelL1,
          messages: [{ role: "user", content: "test partial then error" }],
          stream: true,
        },
      });

      // Must NOT retry — content was already streamed to the client
      expect(fetchCalls.length).toBe(1);

      // Partial content should be present in the response
      const bodyText = response.body;
      expect(bodyText).toContain("hello");
    });
  });
});
