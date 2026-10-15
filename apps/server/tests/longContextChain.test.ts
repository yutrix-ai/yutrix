import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { migrate } from "drizzle-orm/libsql/migrator";
import { and, eq } from "drizzle-orm";
import { isContextOverflowResponse } from "../src/routes/gateway/longContextChain";

const testDbPath = "data/promptgate_test_long_context_chain.sqlite";
process.env.DB_FILE = testDbPath;

describe("isContextOverflowResponse", () => {
  const err = (status: number, message: string) => ({
    status,
    isStream: false,
    data: { error: { message } },
  });

  it("recognizes common upstream context overflow errors", () => {
    expect(isContextOverflowResponse(err(400, "This endpoint's maximum context length is 262144 tokens. However, you requested about 300000 tokens"))).toBe(true);
    expect(isContextOverflowResponse({ status: 400, isStream: false, data: { error: { code: "context_length_exceeded", message: "x" } } })).toBe(true);
    expect(isContextOverflowResponse(err(400, "prompt is too long: 250000 tokens > 200000 maximum"))).toBe(true);
    expect(isContextOverflowResponse(err(400, "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576)."))).toBe(true);
    expect(isContextOverflowResponse({ status: 413, isStream: false, data: "Payload Too Large" })).toBe(true);
  });

  it("ignores rate limits, server errors, streams and unrelated 400s", () => {
    expect(isContextOverflowResponse(err(429, "maximum context length"))).toBe(false);
    expect(isContextOverflowResponse(err(400, "too many tokens per minute, rate limit reached"))).toBe(false);
    expect(isContextOverflowResponse(err(500, "maximum context length"))).toBe(false);
    expect(isContextOverflowResponse({ ...err(400, "maximum context length"), isStream: true })).toBe(false);
    expect(isContextOverflowResponse(err(400, "No endpoints found that support image input"))).toBe(false);
    expect(isContextOverflowResponse(null)).toBe(false);
  });
});

describe("Long-context degrade chain (gateway integration)", () => {
  let db: any;
  let schema: any;
  let apiKey: string;
  const fastify = Fastify();
  const provId = "lc-chain-prov";
  const routeId = "lc-chain-route";

  const resolvedDbPath = () =>
    process.cwd().endsWith("server") ? path.join(process.cwd(), "../../", testDbPath) : path.join(process.cwd(), testDbPath);

  const ok = (model: string) =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-lc",
        object: "chat.completion",
        created: Date.now(),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: `ok:${model}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  const fail = (message: string) =>
    new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });

  const setWindow = async (modelId: string, window: number | null) => {
    await db
      .update(schema.providerModels)
      .set({ rawJson: window ? JSON.stringify({ contextWindowTokens: window }) : null })
      .where(and(eq(schema.providerModels.providerId, provId), eq(schema.providerModels.modelId, modelId)));
  };

  // ~10 history turns of 2000 ASCII chars (~6.6K tokens) plus one image (4096) ≈ 10.7K tokens.
  const imagePayload = () => ({
    model: "vis-1",
    stream: false,
    messages: [
      ...Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i} ` + "x".repeat(2000),
      })),
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "data:image/png;base64,mock" } },
        ],
      },
    ],
  });

  const send = () =>
    fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: imagePayload(),
    });

  const hasImage = (reqBody: any) => JSON.stringify(reqBody.messages || []).includes("image_url");

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(resolvedDbPath() + suffix); } catch {}
    }
    const dbModule = await import("../src/db");
    await dbModule.initDb();
    db = dbModule.db;
    schema = await import("../src/db/schema");
    const { bootstrap } = await import("../src/bootstrap");
    const gatewayRoutes = (await import("../src/routes/gateway")).default;
    const { encryptText } = await import("../src/utils/crypto");

    await migrate(db, {
      migrationsFolder: path.resolve(process.cwd(), process.cwd().endsWith("server") ? "./drizzle" : "apps/server/drizzle"),
    });
    await bootstrap();

    fastify.register(gatewayRoutes);
    await fastify.ready();

    const userId = crypto.randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      username: `lc_chain_${crypto.randomUUID()}`,
      passwordHash: "dummy",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    apiKey = "pg_key_lc_" + crypto.randomUUID();
    await db.insert(schema.apiKeys).values({
      id: crypto.randomUUID(),
      userId,
      name: "LC chain key",
      keyHash: crypto.createHash("sha256").update(apiKey).digest("hex"),
      keyPrefix: "pg_key_lc",
      concurrencyLimit: 5,
      status: "active",
      createdAt: new Date(),
    });
    await db.insert(schema.providers).values({
      id: provId,
      name: "LC Chain Provider",
      openaiBaseUrl: "https://lc.example.com/v1",
      enabled: true,
      concurrencyLimit: 10,
      timeoutMs: 60000,
      streamTimeoutMs: 180000,
      hourlyTokenLimit: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.providerApiKeys).values({
      id: "lc-chain-key-1",
      providerId: provId,
      keyEncrypted: encryptText("sk-lc-dummy"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    for (const modelId of ["vis-1", "vis-2", "lc-a", "lc-small", "lc-b"]) {
      await db.insert(schema.providerModels).values({
        id: crypto.randomUUID(),
        providerId: provId,
        modelId,
        displayName: modelId,
        enabled: true,
        active: true,
        createdAt: new Date(),
      });
    }
    await setWindow("lc-small", 1000);

    await db.insert(schema.endpoints).values({
      id: "lc-chain-ep",
      userId,
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const layer = (modelId: string, vision: string, longContext: string) => ({
      providerId: provId,
      providerProtocol: "openai",
      modelId,
      weight: 100,
      retryCount: 0,
      strategyRoutingEnabled: true,
      strategyRoutingRules: JSON.stringify([
        { providerId: provId, providerProtocol: "openai", modelId: vision, taskType: "vision", enabled: true },
        { providerId: provId, providerProtocol: "openai", modelId: longContext, taskType: "long_context", enabled: true },
      ]),
    });
    await db.insert(schema.endpointRoutes).values({
      id: routeId,
      name: "LC Chain Route",
      endpointId: "lc-chain-ep",
      priority: 1,
      providerId: provId,
      providerProtocol: "openai",
      modelId: "vis-1",
      targetType: "multi",
      fallbackEnabled: 3,
      targets: JSON.stringify([
        layer("vis-1", "vis-1", "lc-a"),
        layer("vis-2", "vis-2", "lc-small"),
        layer("vis-2", "vis-2", "lc-a"),
        layer("vis-2", "vis-2", "lc-b"),
      ]),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId,
      userId,
      createdAt: new Date(),
    });
  });

  afterAll(async () => {
    await fastify.close();
    vi.unstubAllGlobals();
  });

  it("image request exceeding the vision window hops to the same layer's long_context model", async () => {
    await setWindow("vis-1", 8000);
    const requests: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const reqBody = JSON.parse(String(init?.body || "{}"));
      requests.push(reqBody);
      return reqBody.model === "lc-a" ? ok("lc-a") : fail("unexpected");
    });

    const response = await send();
    expect(response.statusCode).toBe(200);
    expect(requests.map((r) => r.model)).toEqual(["lc-a"]);
    expect(hasImage(requests[0])).toBe(true);
  });

  it("upstream context overflow error hops to the long_context model", async () => {
    await setWindow("vis-1", null);
    const requests: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const reqBody = JSON.parse(String(init?.body || "{}"));
      requests.push(reqBody);
      if (reqBody.model === "vis-1") {
        return fail("This endpoint's maximum context length is 8000 tokens. However, you requested about 10700 tokens");
      }
      return reqBody.model === "lc-a" ? ok("lc-a") : fail("unexpected");
    });

    const response = await send();
    expect(response.statusCode).toBe(200);
    expect(requests.map((r) => r.model)).toEqual(["vis-1", "lc-a"]);
  });

  it("a failing long_context model degrades along the chain, skipping too-small and already-tried models", async () => {
    await setWindow("vis-1", 8000);
    const requests: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const reqBody = JSON.parse(String(init?.body || "{}"));
      requests.push(reqBody);
      return reqBody.model === "lc-b" ? ok("lc-b") : fail("bad request");
    });

    const response = await send();
    expect(response.statusCode).toBe(200);
    expect(requests.map((r) => r.model)).toEqual(["lc-a", "lc-b"]);
  });

  it("once the chain is exhausted, the image request lands on a vision model with clipped history", async () => {
    await setWindow("vis-1", 8000);
    const requests: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const reqBody = JSON.parse(String(init?.body || "{}"));
      requests.push(reqBody);
      return reqBody.model === "vis-1" ? ok("vis-1") : fail("bad request");
    });

    const response = await send();
    expect(response.statusCode).toBe(200);
    expect(requests.map((r) => r.model)).toEqual(["lc-a", "lc-b", "vis-1"]);
    const last = requests[requests.length - 1];
    expect(hasImage(last)).toBe(true);
    expect(last.messages.length).toBeLessThan(imagePayload().messages.length);
  });
});
