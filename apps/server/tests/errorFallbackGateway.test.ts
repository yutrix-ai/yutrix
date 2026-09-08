import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";

const dbFile = "data/promptgate_test_error_fallback.sqlite";
const L0 = "https://errfb-l0.test/v1";
const L1 = "https://errfb-l1.test/v1";
const LAST = "https://errfb-last.test/v1";

describe("funnel error fallback on non-200", () => {
  const fastify = Fastify({ logger: false });
  let db: any;
  let client: any;
  let apiKeys: any;
  let endpoints: any;
  let endpointRoutes: any;
  let providerApiKeys: any;
  let providerModels: any;
  let providers: any;
  let routeAuthorizations: any;
  let subdomains: any;
  let systemSettings: any;
  let users: any;
  let encryptText: any;
  let apiKey = "";
  let userId = "";

  beforeAll(async () => {
    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));
    ({
      apiKeys,
      endpoints,
      endpointRoutes,
      providerApiKeys,
      providerModels,
      providers,
      routeAuthorizations,
      subdomains,
      systemSettings,
      users,
    } = await import("../src/db/schema"));
    ({ encryptText } = await import("../src/utils/crypto"));

    userId = crypto.randomUUID();
    const now = new Date();
    await db.insert(users).values({
      id: userId,
      username: "errfb-user",
      passwordHash: "dummy",
      role: "user",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const rawKey = "pg_key_errfb_" + crypto.randomBytes(8).toString("hex");
    apiKey = rawKey;
    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      userId,
      name: "errfb key",
      keyHash: crypto.createHash("sha256").update(rawKey).digest("hex"),
      keyPrefix: rawKey.substring(0, 12),
      status: "active",
      concurrencyLimit: 10,
      createdAt: now,
    });

    await db.delete(systemSettings).where(eq(systemSettings.key, "allowUnknownHostFallback"));
    await db.insert(systemSettings).values({
      key: "allowUnknownHostFallback",
      value: "true",
      description: "error fallback tests",
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(systemSettings)
      .set({ value: "example.com", updatedAt: now })
      .where(eq(systemSettings.key, "mainDomain"));

    const providerRows = [
      { id: "errfb-p-l0", name: "Errfb L0", url: L0 },
      { id: "errfb-p-l1", name: "Errfb L1", url: L1 },
      { id: "errfb-p-last", name: "Errfb Last", url: LAST },
    ];
    await db.insert(providers).values(
      providerRows.map((p) => ({
        id: p.id,
        name: p.name,
        openaiBaseUrl: p.url,
        anthropicBaseUrl: null,
        enabled: true,
        concurrencyLimit: 10,
        timeoutMs: 30000,
        maxOutputTokens: 0,
        createdAt: now,
        updatedAt: now,
      })),
    );
    await db.insert(providerModels).values([
      {
        id: crypto.randomUUID(),
        providerId: "errfb-p-l0",
        modelId: "minimax-free",
        displayName: "MiniMax Free",
        enabled: true,
        active: true,
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        providerId: "errfb-p-l1",
        modelId: "minimax-m3",
        displayName: "MiniMax M3",
        enabled: true,
        active: true,
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        providerId: "errfb-p-last",
        modelId: "only-model",
        displayName: "Only",
        enabled: true,
        active: true,
        createdAt: now,
      },
    ]);
    await db.insert(providerApiKeys).values(
      providerRows.map((p) => ({
        id: `${p.id}-key`,
        providerId: p.id,
        keyEncrypted: encryptText("sk-errfb"),
        status: "active",
        createdAt: now,
        updatedAt: now,
      })),
    );

    await db.insert(subdomains).values([
      {
        id: "errfb-sub-hop",
        userId,
        name: "errfb-hop",
        hostname: "errfb-hop.example.com",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "errfb-sub-last",
        userId,
        name: "errfb-last",
        hostname: "errfb-last.example.com",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const endpointId = "errfb-endpoint";
    await db.insert(endpoints).values({
      id: endpointId,
      userId,
      name: "Error fallback endpoint",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(endpointRoutes).values([
      {
        id: "errfb-route-hop",
        name: "Error fallback hop",
        endpointId,
        subdomainId: "errfb-sub-hop",
        providerId: "errfb-p-l0",
        providerProtocol: "openai",
        modelId: "minimax-free",
        retryCount: 3,
        targets: JSON.stringify([
          {
            providerId: "errfb-p-l0",
            modelId: "minimax-free",
            providerProtocol: "openai",
            bestEffort: false,
            strategyRoutingEnabled: false,
            strategyRoutingRules: [],
          },
          {
            providerId: "errfb-p-l1",
            modelId: "minimax-m3",
            providerProtocol: "openai",
            bestEffort: false,
            strategyRoutingEnabled: false,
            strategyRoutingRules: [],
          },
        ]),
        enabled: true,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "errfb-route-last",
        name: "Error fallback last layer",
        endpointId,
        subdomainId: "errfb-sub-last",
        providerId: "errfb-p-last",
        providerProtocol: "openai",
        modelId: "only-model",
        retryCount: 3,
        targets: JSON.stringify([
          {
            providerId: "errfb-p-last",
            modelId: "only-model",
            providerProtocol: "openai",
            bestEffort: false,
            strategyRoutingEnabled: false,
            strategyRoutingRules: [],
          },
        ]),
        enabled: true,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(routeAuthorizations).values([
      { id: crypto.randomUUID(), routeId: "errfb-route-hop", userId, createdAt: now },
      { id: crypto.randomUUID(), routeId: "errfb-route-last", userId, createdAt: now },
    ]);

    const gatewayRoutes = (await import("../src/routes/gateway")).default;
    await fastify.register(gatewayRoutes);
    await fastify.ready();
  }, 30000);

  afterAll(async () => {
    await fastify.close();
    await closeAndCleanup(client, dbFile);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function openaiSuccess(model: string, content: string) {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-errfb",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  function openaiStreamSuccess(content: string) {
    const sseText =
      [
        `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`,
        `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":5,"total_tokens":10}}`,
        `data: [DONE]`,
      ].join("\n\n") + "\n\n";
    return new Response(sseText, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  function modelNotFound() {
    return new Response(
      JSON.stringify({
        message: "This model is unavailable for free. The paid version is available now - use this slug instead: minimax/minimax-m3",
        type: "invalid_request_error",
        param: null,
        code: "model_not_found",
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }

  async function chat(host: string, model: string, stream = false) {
    return fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
        host,
      },
      payload: {
        model,
        messages: [{ role: "user", content: "hello" }],
        stream,
      },
    });
  }

  it("hops to L1 on the first 404 model_not_found", async () => {
    const receivedCalls: Array<{ url: string; model: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      receivedCalls.push({ url: String(url), model: body.model });
      if (String(url).includes("errfb-l0.test")) return modelNotFound();
      if (String(url).includes("errfb-l1.test")) return openaiSuccess(body.model, "l1 404 hop success");
      return new Response("not-found", { status: 404 });
    });

    const response = await chat("errfb-hop.example.com", "minimax-free");
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("l1 404 hop success");
    expect(receivedCalls.filter((c) => c.url.includes("errfb-l0.test"))).toHaveLength(1);
    expect(receivedCalls.filter((c) => c.url.includes("errfb-l1.test"))).toEqual([
      { url: `${L1}/chat/completions`, model: "minimax-m3" },
    ]);
  });

  it("hops to L1 when a streaming client gets JSON 404 before SSE starts", async () => {
    const receivedCalls: Array<{ url: string; model: string; stream?: boolean }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      receivedCalls.push({ url: String(url), model: body.model, stream: body.stream });
      if (String(url).includes("errfb-l0.test")) return modelNotFound();
      if (String(url).includes("errfb-l1.test")) return openaiStreamSuccess("l1 stream 404 hop");
      return new Response("not-found", { status: 404 });
    });

    const response = await chat("errfb-hop.example.com", "minimax-free", true);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("l1 stream 404 hop");
    expect(receivedCalls.filter((c) => c.url.includes("errfb-l0.test"))).toHaveLength(1);
    expect(receivedCalls.filter((c) => c.url.includes("errfb-l1.test"))).toEqual([
      { url: `${L1}/chat/completions`, model: "minimax-m3", stream: true },
    ]);
  });

  it("surfaces 404 when the last layer has no further model", async () => {
    const receivedCalls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      receivedCalls.push(String(url));
      if (String(url).includes("errfb-last.test")) return modelNotFound();
      return new Response("not-found", { status: 404 });
    });

    const response = await chat("errfb-last.example.com", "only-model");
    expect(response.statusCode).toBe(404);
    expect(receivedCalls.filter((url) => url.includes("errfb-last.test"))).toHaveLength(1);
  });
});
