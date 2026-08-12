import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq, like } from "drizzle-orm";
import { encryptText } from "../src/utils/crypto";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import * as actionLogger from "../src/utils/actionLogger";

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
let requestLogs: any;
let chatLogs: any;
let gatewayRoutes: any;

const dbFile = "data/promptgate-test-empty-output-integration.sqlite";

describe("Empty Output Auto-Continuation Integration", () => {
  const fastify = Fastify();
  let apiKey = "";
  let userId = "";
  let savedDbFile: string | undefined;
  const loggedActions: any[] = [];
  let unsubscribe: (() => void) | undefined;

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
      requestLogs,
      chatLogs,
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
      username: "testuser_empty_out",
      passwordHash: "dummy",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rawKey = "pg_key_empty_" + crypto.randomUUID().slice(0, 8);
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

    unsubscribe = actionLogger.subscribeActionLogs((entry: any) => {
      loggedActions.push({
        code: entry.code || entry.params?.code,
        modelId: entry.modelId || entry.params?.modelId,
      });
    });
  });

  afterAll(async () => {
    if (unsubscribe) unsubscribe();
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
    loggedActions.length = 0;
    if (db) {
      try {
        await db.delete(routeAuthorizations).where(like(routeAuthorizations.routeId, "emp-%"));
        await db.delete(endpointRoutes).where(like(endpointRoutes.id, "emp-%"));
        await db.delete(endpoints).where(like(endpoints.id, "emp-%"));
        await db.delete(providerModels).where(like(providerModels.providerId, "emp-%"));
        await db.delete(providerApiKeys).where(like(providerApiKeys.providerId, "emp-%"));
        await db.delete(providers).where(like(providers.id, "emp-%"));
        await db.delete(requestLogs);
        await db.delete(chatLogs);
      } catch (e) {
        console.error("Cleanup error:", e);
      }
    }
  });

  async function setupEnvironment() {
    await db.insert(providers).values({
      id: "emp-prov-1",
      name: "Empty Output Provider",
      openaiBaseUrl: "https://api.openai.com/v1",
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerApiKeys).values({
      id: "emp-prov-1-key",
      providerId: "emp-prov-1",
      keyEncrypted: encryptText("sk-dummy"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: "emp-prov-1",
      modelId: "gemini-3.6-flash",
      displayName: "Gemini 3.6 Flash",
      enabled: true,
      createdAt: new Date(),
    });
    await db.insert(endpoints).values({
      id: "emp-ep-1",
      userId,
      name: "Endpoint",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(endpointRoutes).values({
      id: "emp-route-1",
      endpointId: "emp-ep-1",
      name: "Test Route",
      providerId: "emp-prov-1",
      providerProtocol: "openai",
      modelId: "gemini-3.6-flash",
      strategyRoutingEnabled: false,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: "emp-route-1",
      userId,
      createdAt: new Date(),
    });
  }

  it("does not auto-continue empty JSON while EmptyOutput is unregistered (OpenCode regression)", async () => {
    await setupEnvironment();

    let callCount = 0;
    const receivedBodies: any[] = [];

    const mockFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      callCount++;
      const body = JSON.parse(init.body);
      receivedBodies.push(body);

      if (callCount === 1) {
        // Turn 1: Empty 0-token response from upstream model
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            id: "chatcmpl-empty-1",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "gemini-3.6-flash",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 },
          }),
        };
      } else {
        // Turn 2: Recovered response after auto-injected continuation prompt
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            id: "chatcmpl-success-2",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "gemini-3.6-flash",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "export const getRecordList = () => {}" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 70, completion_tokens: 25, total_tokens: 95 },
          }),
        };
      }
    });

    vi.stubGlobal("fetch", mockFetch);

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gemini-3.6-flash",
        messages: [{ role: "user", content: "Generate API code" }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.choices[0].message.content).toBe("");
    expect(callCount).toBe(1);
  });

  it("does not inject EmptyOutput fallback while the strategy is unregistered", async () => {
    await setupEnvironment();

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          id: `chatcmpl-empty-${callCount}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gemini-3.6-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 },
        }),
      };
    });

    vi.stubGlobal("fetch", mockFetch);

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gemini-3.6-flash",
        messages: [{ role: "user", content: "Generate API code" }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.choices[0].message.content).toBe("");
    expect(callCount).toBe(1);
  });

  it("stream=true forwards empty JSON fake-stream once without EmptyOutput retry", async () => {
    await setupEnvironment();

    let callCount = 0;
    const receivedBodies: any[] = [];

    // Use real Response objects: stream+JSON path reads body via response.text().
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      callCount++;
      const body = JSON.parse(init.body);
      receivedBodies.push(body);

      // Upstream returns application/json even when client requested stream
      // (gateway wraps it as a fake SSE stream).
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-empty-stream-1",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "gemini-3.6-flash",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          id: "chatcmpl-success-stream-2",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gemini-3.6-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "export const getRecordList = () => {}" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 70, completion_tokens: 25, total_tokens: 95 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", mockFetch);

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gemini-3.6-flash",
        messages: [{ role: "user", content: "Generate API code" }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(callCount).toBe(1);

    // Client SSE should carry recovered content and a single terminal stop/[DONE]
    // without a premature empty terminal completion from turn 1.
    const lines = res.body.split("\n").filter((l) => l.startsWith("data: "));
    let text = "";
    let finishReasons: (string | null)[] = [];
    let doneFound = false;
    let emptyStopBeforeContent = false;
    let sawContent = false;

    for (const line of lines) {
      const payload = line.replace("data: ", "").trim();
      if (payload === "[DONE]") {
        doneFound = true;
        continue;
      }
      let chunk: any;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const deltaContent = chunk.choices?.[0]?.delta?.content;
      if (typeof deltaContent === "string" && deltaContent.length > 0) {
        text += deltaContent;
        sawContent = true;
      }
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr) {
        finishReasons.push(fr);
        if (!sawContent && fr === "stop") {
          emptyStopBeforeContent = true;
        }
      }
    }

    expect(text).toBe("");
    expect(finishReasons.at(-1)).toBe("stop");
    expect(doneFound).toBe(true);
    expect(callCount).toBe(1);
  });

  it("stream=true forwards empty native SSE stop/[DONE] without holding the stream", async () => {
    await setupEnvironment();

    let callCount = 0;
    const receivedBodies: any[] = [];

    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      callCount++;
      receivedBodies.push(JSON.parse(init.body));

      if (callCount === 1) {
        const streamText =
          `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n` +
          `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
          `data: {"usage":{"prompt_tokens":539,"completion_tokens":2,"total_tokens":541}}\n\n` +
          `data: [DONE]\n\n`;
        return new Response(streamText, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      const recovered =
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"你好，我是数字员工助手。"}}]}\n\n` +
        `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
        `data: [DONE]\n\n`;
      return new Response(recovered, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    vi.stubGlobal("fetch", mockFetch);

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gemini-3.6-flash",
        messages: [{ role: "user", content: "请介绍自己" }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(callCount).toBe(1);
    expect(res.body).toContain("finish_reason");
    expect(res.body).toContain("[DONE]");
  });

  it("stream=true forwards reasoning-only native SSE without EmptyOutput retry", async () => {
    await setupEnvironment();

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      callCount++;
      if (callCount === 1) {
        const streamText =
          `data: {"choices":[{"index":0,"delta":{"reasoning_content":"ok"}}]}\n\n` +
          `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
          `data: [DONE]\n\n`;
        return new Response(streamText, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      const recovered =
        `data: {"choices":[{"index":0,"delta":{"content":"我是助手。"}}]}\n\n` +
        `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
        `data: [DONE]\n\n`;
      return new Response(recovered, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    vi.stubGlobal("fetch", mockFetch);

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gemini-3.6-flash",
        messages: [{ role: "user", content: "请介绍自己" }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(callCount).toBe(1);
    expect(res.body).toContain("reasoning_content");
    expect(res.body).toContain("\"content\":\"ok\"");
    expect(res.body).toContain("[DONE]");
  });

  it("stream=true OpenAI client receives visible text when upstream JSON has type=message", async () => {
    await setupEnvironment();

    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            type: "message",
            id: "chatcmpl-ag-1",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "你好，我是数字员工助手。" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 539, completion_tokens: 2, total_tokens: 541 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gemini-3.6-flash",
        messages: [{ role: "user", content: "请介绍自己" }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/event:\s*message_start/);
    expect(res.body).toContain("你好，我是数字员工助手。");
    expect(res.body).toContain("[DONE]");
  });
});
