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
        strategy: entry.strategy || entry.params?.strategy,
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
        if (userId) {
          await db.update(users).set({ maxInputTokensOverride: null }).where(eq(users.id, userId));
        }
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

  it("retries the same body once when provider reports completion_tokens=0", async () => {
    await setupEnvironment();

    let callCount = 0;
    const receivedBodies: any[] = [];

    const mockFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      callCount++;
      const body = JSON.parse(init.body);
      receivedBodies.push(body);

      if (callCount === 1) {
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
      }
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

    expect(callCount).toBe(2);
    expect(receivedBodies[1].messages).toEqual(receivedBodies[0].messages);
    expect(body.choices[0].message.content).toBe("export const getRecordList = () => {}");
  });

  it("emits a visible fallback after one same-body retry still returns 0 tokens", async () => {
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

    expect(callCount).toBe(2);
    expect(body.choices[0].message.content).toContain("0 输出 token");
  });

  it("retries empty JSON when usage is omitted but the completed log would be in/0/in", async () => {
    await setupEnvironment();

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          id: "chatcmpl-empty-nousage",
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
    expect(callCount).toBe(2);
    expect(res.json().choices[0].message.content).toContain("0 输出 token");
  });

  it("stream=true retries empty JSON fake-stream once then forwards recovered content", async () => {
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
    expect(callCount).toBe(2);
    expect(receivedBodies[1].messages).toEqual(receivedBodies[0].messages);

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

    expect(text).toBe("export const getRecordList = () => {}");
    expect(finishReasons.at(-1)).toBe("stop");
    expect(doneFound).toBe(true);
    expect(emptyStopBeforeContent).toBe(false);
  });

  it("stream=true retries native SSE when trailer reports completion_tokens=0", async () => {
    await setupEnvironment();

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      callCount++;
      if (callCount === 1) {
        const streamText =
          `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n` +
          `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
          `data: {"usage":{"prompt_tokens":2916,"completion_tokens":0,"total_tokens":2916}}\n\n` +
          `data: [DONE]\n\n`;
        return new Response(streamText, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      const recovered =
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"export const getRecordList = () => {}"}}]}\n\n` +
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
        messages: [{ role: "user", content: "Generate API code" }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(callCount).toBe(2);
    expect(res.body).toContain("export const getRecordList = () => {}");
    expect(res.body).toContain("[DONE]");
    const firstStop = res.body.indexOf("\"finish_reason\":\"stop\"");
    const firstContent = res.body.indexOf("export const getRecordList");
    expect(firstContent).toBeGreaterThan(-1);
    expect(firstStop).toBeGreaterThan(firstContent);
  });

  it("stream=true retries empty native SSE when usage is omitted", async () => {
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
          `data: [DONE]\n\n`;
        return new Response(streamText, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      const recovered =
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"export const getRecordList = () => {}"}}]}\n\n` +
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
        messages: [{ role: "user", content: "Generate API code" }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(callCount).toBe(2);
    expect(receivedBodies[1].messages).toEqual(receivedBodies[0].messages);
    expect(JSON.stringify(receivedBodies[1].messages)).not.toMatch(/请继续|continue/i);
    expect(res.body).toContain("export const getRecordList = () => {}");
    const omittedFirstStop = res.body.indexOf("\"finish_reason\":\"stop\"");
    const omittedFirstContent = res.body.indexOf("export const getRecordList");
    expect(omittedFirstContent).toBeGreaterThan(-1);
    expect(omittedFirstStop).toBeGreaterThan(omittedFirstContent);
  });

  it("stream=true emits visible fallback after native SSE still returns 0 tokens", async () => {
    await setupEnvironment();

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      const streamText =
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n` +
        `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
        `data: {"usage":{"prompt_tokens":100,"completion_tokens":0,"total_tokens":100}}\n\n` +
        `data: [DONE]\n\n`;
      return new Response(streamText, {
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
        messages: [{ role: "user", content: "Generate API code" }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(callCount).toBe(2);
    expect(res.body).toContain("0 输出 token");
    expect(res.body).toContain("[DONE]");
    const fallbackAt = res.body.indexOf("0 输出 token");
    const stopAt = res.body.indexOf("\"finish_reason\":\"stop\"");
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(fallbackAt);
    const exhausted = loggedActions.find((a) => a.code === "request.continuity.exhausted");
    expect(exhausted?.strategy).toBe("EmptyOutput");
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

  it("stream=true retries reasoning-only zero-completion instead of promoting think as the answer", async () => {
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
    expect(callCount).toBe(2);
    expect(res.body).toContain("我是助手。");
    expect(res.body).not.toContain("请重新发送");
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

  async function setupAnthropicInbound() {
    await db.insert(providers).values({
      id: "emp-prov-1",
      name: "Empty Output Provider",
      openaiBaseUrl: "https://api.openai.com/v1",
      anthropicBaseUrl: "https://api.anthropic.com",
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
      id: "emp-ep-ant",
      userId,
      name: "Anthropic Endpoint",
      path: "/v1/messages",
      incomingProtocol: "anthropic",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(endpointRoutes).values({
      id: "emp-route-ant",
      endpointId: "emp-ep-ant",
      name: "Anthropic Test Route",
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
      routeId: "emp-route-ant",
      userId,
      createdAt: new Date(),
    });
  }

  it("Anthropic inbound empty live SSE retries once before message_stop", async () => {
    await setupAnthropicInbound();

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        const streamText =
          `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n` +
          `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
          `data: {"usage":{"prompt_tokens":80,"completion_tokens":0,"total_tokens":80}}\n\n` +
          `data: [DONE]\n\n`;
        return new Response(streamText, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      const recovered =
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"审核字段已规划"}}]}\n\n` +
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
      url: "/v1/messages",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      payload: {
        model: "gemini-3.6-flash",
        messages: [{ role: "user", content: "add audit fields" }],
        max_tokens: 256,
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(callCount).toBe(2);
    expect(res.body).toContain("审核字段已规划");
    const recoveredAt = res.body.indexOf("审核字段已规划");
    const firstStop = res.body.indexOf("message_stop");
    expect(recoveredAt).toBeGreaterThan(-1);
    expect(firstStop).toBeGreaterThan(recoveredAt);
    expect((res.body.match(/event: message_stop/g) || []).length).toBe(1);
  });

  it("native Anthropic empty stream retries once before message_stop", async () => {
    await db.insert(providers).values({
      id: "emp-prov-1",
      name: "Native Anthropic Empty",
      anthropicBaseUrl: "https://api.anthropic.com",
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
      id: "emp-ep-nat",
      userId,
      name: "Native Anthropic Endpoint",
      path: "/v1/messages",
      incomingProtocol: "anthropic",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(endpointRoutes).values({
      id: "emp-route-nat",
      endpointId: "emp-ep-nat",
      name: "Native Anthropic Route",
      providerId: "emp-prov-1",
      providerProtocol: "anthropic",
      modelId: "gemini-3.6-flash",
      strategyRoutingEnabled: false,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: "emp-route-nat",
      userId,
      createdAt: new Date(),
    });

    let callCount = 0;
    vi.stubGlobal("fetch", async () => {
      callCount++;
      if (callCount === 1) {
        const sse = [
          `event: message_start`,
          `data: {"type":"message_start","message":{"id":"msg_empty","role":"assistant","content":[],"model":"claude","stop_reason":null,"usage":{"input_tokens":40,"output_tokens":0}}}`,
          ``,
          `event: message_delta`,
          `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}`,
          ``,
          `event: message_stop`,
          `data: {"type":"message_stop"}`,
          ``,
        ].join("\n");
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      const recovered = [
        `event: message_start`,
        `data: {"type":"message_start","message":{"id":"msg_ok","role":"assistant","content":[],"model":"claude","stop_reason":null,"usage":{"input_tokens":40,"output_tokens":0}}}`,
        ``,
        `event: content_block_start`,
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
        ``,
        `event: content_block_delta`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"native recovered"}}`,
        ``,
        `event: content_block_stop`,
        `data: {"type":"content_block_stop","index":0}`,
        ``,
        `event: message_delta`,
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}`,
        ``,
        `event: message_stop`,
        `data: {"type":"message_stop"}`,
        ``,
      ].join("\n");
      return new Response(recovered, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      payload: {
        model: "gemini-3.6-flash",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 64,
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(callCount).toBe(2);
    expect(res.body).toContain("native recovered");
    const recoveredAt = res.body.indexOf("native recovered");
    const firstStop = res.body.indexOf("event: message_stop");
    expect(firstStop).toBeGreaterThan(recoveredAt);
    expect((res.body.match(/event: message_stop/g) || []).length).toBe(1);
    expect((res.body.match(/event: message_start/g) || []).length).toBe(1);
    expect(res.body.indexOf("event: message_start")).toBeLessThan(recoveredAt);
  });

  it("native Anthropic empty-then-empty emits fallback before message_stop", async () => {
    await db.insert(providers).values({
      id: "emp-prov-1",
      name: "Native Anthropic Exhaust",
      anthropicBaseUrl: "https://api.anthropic.com",
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
      id: "emp-ep-nat-exh",
      userId,
      name: "Native Anthropic Exhaust Endpoint",
      path: "/v1/messages",
      incomingProtocol: "anthropic",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(endpointRoutes).values({
      id: "emp-route-nat-exh",
      endpointId: "emp-ep-nat-exh",
      name: "Native Anthropic Exhaust Route",
      providerId: "emp-prov-1",
      providerProtocol: "anthropic",
      modelId: "gemini-3.6-flash",
      strategyRoutingEnabled: false,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: "emp-route-nat-exh",
      userId,
      createdAt: new Date(),
    });

    const emptySse = [
      `event: message_start`,
      `data: {"type":"message_start","message":{"id":"msg_empty","role":"assistant","content":[],"model":"claude","stop_reason":null,"usage":{"input_tokens":40,"output_tokens":0}}}`,
      ``,
      `event: message_delta`,
      `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}`,
      ``,
      `event: message_stop`,
      `data: {"type":"message_stop"}`,
      ``,
    ].join("\n");
    vi.stubGlobal("fetch", async () => new Response(emptySse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      payload: {
        model: "gemini-3.6-flash",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 64,
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("0 输出 token");
    const fallbackAt = res.body.indexOf("0 输出 token");
    const stopAt = res.body.indexOf("event: message_stop");
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(fallbackAt);
    expect((res.body.match(/event: message_start/g) || []).length).toBe(1);
    const exhausted = loggedActions.find((a) => a.code === "request.continuity.exhausted");
    expect(exhausted?.strategy).toBe("EmptyOutput");
  });

  it("sidecar title empty in/0/in retries the same messages", async () => {
    await setupEnvironment();

    let callCount = 0;
    const receivedBodies: any[] = [];
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      callCount++;
      receivedBodies.push(JSON.parse(init.body));
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            id: "chatcmpl-title-empty",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "gemini-3.6-flash",
            choices: [
              { index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 40, completion_tokens: 0, total_tokens: 40 },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          id: "chatcmpl-title-ok",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gemini-3.6-flash",
          choices: [
            { index: 0, message: { role: "assistant", content: "长护险审核字段" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
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
        messages: [
          { role: "user", content: "Generate a title for this conversation:\n" },
          { role: "user", content: "添加审核状态" },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(callCount).toBe(2);
    expect(receivedBodies[1].messages).toEqual(receivedBodies[0].messages);
    expect(JSON.stringify(receivedBodies[1].messages)).not.toMatch(/请继续|continue/i);
    expect(res.json().choices[0].message.content).toBe("长护险审核字段");
  });

  async function setupFunnelEnvironment(layerCount: 2 | 3 | 4 = 2) {
    const now = new Date();
    await db.insert(providers).values([
      {
        id: "emp-prov-l0",
        name: "Empty L0",
        openaiBaseUrl: "https://l0.empty.test/v1",
        enabled: true,
        concurrencyLimit: 10,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "emp-prov-l1",
        name: "Empty L1",
        openaiBaseUrl: "https://l1.empty.test/v1",
        enabled: true,
        concurrencyLimit: 10,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "emp-prov-l2",
        name: "Empty L2",
        openaiBaseUrl: "https://l2.empty.test/v1",
        enabled: true,
        concurrencyLimit: 10,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "emp-prov-l3",
        name: "Empty L3",
        openaiBaseUrl: "https://l3.empty.test/v1",
        enabled: true,
        concurrencyLimit: 10,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(providerApiKeys).values([
      { id: "emp-prov-l0-key", providerId: "emp-prov-l0", keyEncrypted: encryptText("sk-l0"), status: "active", createdAt: now, updatedAt: now },
      { id: "emp-prov-l1-key", providerId: "emp-prov-l1", keyEncrypted: encryptText("sk-l1"), status: "active", createdAt: now, updatedAt: now },
      { id: "emp-prov-l2-key", providerId: "emp-prov-l2", keyEncrypted: encryptText("sk-l2"), status: "active", createdAt: now, updatedAt: now },
      { id: "emp-prov-l3-key", providerId: "emp-prov-l3", keyEncrypted: encryptText("sk-l3"), status: "active", createdAt: now, updatedAt: now },
    ]);
    await db.insert(providerModels).values([
      { id: crypto.randomUUID(), providerId: "emp-prov-l0", modelId: "gemini-3.6-flash", displayName: "L0", enabled: true, createdAt: now },
      { id: crypto.randomUUID(), providerId: "emp-prov-l1", modelId: "gemini-pro-agent", displayName: "L1", enabled: true, createdAt: now },
      { id: crypto.randomUUID(), providerId: "emp-prov-l2", modelId: "claude-sonnet", displayName: "L2", enabled: true, createdAt: now },
      { id: crypto.randomUUID(), providerId: "emp-prov-l3", modelId: "gemini-pro-agent", displayName: "L3", enabled: true, createdAt: now },
    ]);
    const targets = [
      { providerId: "emp-prov-l0", modelId: "gemini-3.6-flash", providerProtocol: "openai" },
      { providerId: "emp-prov-l1", modelId: "gemini-pro-agent", providerProtocol: "openai" },
    ];
    if (layerCount >= 3) {
      targets.push({ providerId: "emp-prov-l2", modelId: "claude-sonnet", providerProtocol: "openai" });
    }
    if (layerCount >= 4) {
      targets.push({ providerId: "emp-prov-l3", modelId: "gemini-pro-agent", providerProtocol: "openai" });
    }
    await db.insert(endpoints).values({
      id: "emp-ep-1",
      userId,
      name: "Funnel Endpoint",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(endpointRoutes).values({
      id: "emp-route-1",
      endpointId: "emp-ep-1",
      name: "Funnel Route",
      providerId: "emp-prov-l0",
      providerProtocol: "openai",
      modelId: "gemini-3.6-flash",
      strategyRoutingEnabled: false,
      targets: JSON.stringify(targets),
      retryCount: 5,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: "emp-route-1",
      userId,
      createdAt: now,
    });
  }

  function emptyJson(id: string) {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "gemini-3.6-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 0, total_tokens: 40 },
      }),
    };
  }

  it("after L0 is clipped by the user input cap, L1 hop still sends the original uncut messages", async () => {
    await setupFunnelEnvironment(2);
    await db.update(users).set({ maxInputTokensOverride: 200 }).where(eq(users.id, userId));

    const messages = [
      { role: "user", content: "old turn one ".repeat(400) },
      { role: "assistant", content: "old answer one" },
      { role: "user", content: "old turn two ".repeat(400) },
      { role: "assistant", content: "old answer two" },
      { role: "user", content: "latest question with enough leftover room" },
    ];
    const urls: string[] = [];
    const receivedBodies: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      urls.push(String(url));
      receivedBodies.push(JSON.parse(init.body));
      if (String(url).includes("l0.empty.test")) return emptyJson(`empty-l0-${urls.length}`);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          id: "ok-l1-uncut",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gemini-pro-agent",
          choices: [{ index: 0, message: { role: "assistant", content: "L1 uncut recovered" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 80, completion_tokens: 8, total_tokens: 88 },
        }),
      };
    });

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "gemini-3.6-flash", messages },
    });

    expect(res.statusCode).toBe(200);
    expect(urls.filter((u) => u.includes("l0.empty.test")).length).toBe(2);
    expect(urls.filter((u) => u.includes("l1.empty.test")).length).toBe(1);
    const l0Messages = receivedBodies[0].messages;
    expect(l0Messages.length).toBeLessThan(messages.length);
    expect(l0Messages).not.toEqual(messages);
    expect(receivedBodies[2].messages).toEqual(messages);
    expect(res.json().choices[0].message.content).toContain("L1 uncut recovered");
    expect(res.json().choices[0].message.content).not.toContain("请重新发送");
  });

  it("after L0 empty twice hops once to L1 with the uncut messages and no resend fallback", async () => {
    await setupFunnelEnvironment(2);
    const urls: string[] = [];
    const receivedBodies: any[] = [];
    let callCount = 0;
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      callCount++;
      urls.push(String(url));
      receivedBodies.push(JSON.parse(init.body));
      if (String(url).includes("l0.empty.test")) return emptyJson(`empty-l0-${callCount}`);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          id: "ok-l1",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gemini-pro-agent",
          choices: [{ index: 0, message: { role: "assistant", content: "L1 recovered answer" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
        }),
      };
    });

    const messages = [{ role: "user", content: "Generate API code" }];
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "gemini-3.6-flash", messages },
    });

    expect(res.statusCode).toBe(200);
    expect(callCount).toBe(3);
    expect(urls[0]).toContain("l0.empty.test");
    expect(urls[1]).toContain("l0.empty.test");
    expect(urls[2]).toContain("l1.empty.test");
    expect(receivedBodies[2].messages).toEqual(messages);
    expect(JSON.stringify(receivedBodies[2].messages)).not.toMatch(/请继续|continue/i);
    const content = res.json().choices[0].message.content;
    expect(content).toContain("L1 recovered answer");
    expect(content).not.toContain("0 输出 token");
    expect(content).not.toContain("请重新发送");
  });

  it("walks remaining funnel layers after EmptyOutput like a 500 degrade and recovers on L3", async () => {
    await setupFunnelEnvironment(4);
    const urls: string[] = [];
    const receivedBodies: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      urls.push(String(url));
      receivedBodies.push(JSON.parse(init.body));
      if (!String(url).includes("l3.empty.test")) return emptyJson(`empty-${urls.length}`);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          id: "ok-l3",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gemini-pro-agent",
          choices: [{ index: 0, message: { role: "assistant", content: "L3 recovered answer" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
        }),
      };
    });

    const messages = [{ role: "user", content: "hello" }];
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "gemini-3.6-flash", messages },
    });

    expect(res.statusCode).toBe(200);
    expect(urls.filter((u) => u.includes("l0.empty.test")).length).toBe(2);
    expect(urls.filter((u) => u.includes("l1.empty.test")).length).toBe(1);
    expect(urls.filter((u) => u.includes("l2.empty.test")).length).toBe(1);
    expect(urls.filter((u) => u.includes("l3.empty.test")).length).toBe(1);
    expect(receivedBodies[4].messages).toEqual(messages);
    const content = res.json().choices[0].message.content;
    expect(content).toContain("L3 recovered answer");
    expect(content).not.toContain("请重新发送");
  });

  it("emits fallback only after every later funnel layer is also empty", async () => {
    await setupFunnelEnvironment(4);
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return emptyJson(`empty-${urls.length}`);
    });

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "gemini-3.6-flash", messages: [{ role: "user", content: "hello" }] },
    });

    expect(res.statusCode).toBe(200);
    expect(urls.filter((u) => u.includes("l0.empty.test")).length).toBe(2);
    expect(urls.filter((u) => u.includes("l1.empty.test")).length).toBe(1);
    expect(urls.filter((u) => u.includes("l2.empty.test")).length).toBe(1);
    expect(urls.filter((u) => u.includes("l3.empty.test")).length).toBe(1);
    expect(res.json().choices[0].message.content).toContain("请重新发送");
  });

  it("stream=true walks L1 empty to L2 content and withholds stop until then", async () => {
    await setupFunnelEnvironment(3);
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      if (!String(url).includes("l2.empty.test")) {
        const streamText =
          `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n` +
          `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
          `data: {"usage":{"prompt_tokens":40,"completion_tokens":0,"total_tokens":40}}\n\n` +
          `data: [DONE]\n\n`;
        return new Response(streamText, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      const recovered =
        `data: {"choices":[{"index":0,"delta":{"content":"L2 stream answer"}}]}\n\n` +
        `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
        `data: [DONE]\n\n`;
      return new Response(recovered, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "gemini-3.6-flash", messages: [{ role: "user", content: "hello" }], stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(urls.filter((u) => u.includes("l0.empty.test")).length).toBe(2);
    expect(urls.filter((u) => u.includes("l1.empty.test")).length).toBe(1);
    expect(urls.filter((u) => u.includes("l2.empty.test")).length).toBe(1);
    expect(res.body).toContain("L2 stream answer");
    expect(res.body).not.toContain("请重新发送");
    const firstStop = res.body.indexOf("\"finish_reason\":\"stop\"");
    const firstContent = res.body.indexOf("L2 stream answer");
    expect(firstStop).toBeGreaterThan(firstContent);
  });

  it("stream=true withholds empty stop until L1 content", async () => {
    await setupFunnelEnvironment(2);
    let callCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      callCount++;
      if (String(url).includes("l0.empty.test")) {
        const streamText =
          `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n` +
          `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
          `data: {"usage":{"prompt_tokens":40,"completion_tokens":0,"total_tokens":40}}\n\n` +
          `data: [DONE]\n\n`;
        return new Response(streamText, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      const recovered =
        `data: {"choices":[{"index":0,"delta":{"content":"L1 stream answer"}}]}\n\n` +
        `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
        `data: [DONE]\n\n`;
      return new Response(recovered, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "gemini-3.6-flash", messages: [{ role: "user", content: "hello" }], stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(callCount).toBe(3);
    expect(res.body).toContain("L1 stream answer");
    expect(res.body).not.toContain("0 输出 token");
    const firstStop = res.body.indexOf("\"finish_reason\":\"stop\"");
    const firstContent = res.body.indexOf("L1 stream answer");
    expect(firstContent).toBeGreaterThan(-1);
    expect(firstStop).toBeGreaterThan(firstContent);
  });
});
