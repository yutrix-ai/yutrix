import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq, like } from "drizzle-orm";
import { encryptText } from "../src/utils/crypto";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import * as actionLogger from "../src/utils/actionLogger";
import { MaxTokensTruncationStrategy } from "../src/services/continuity/strategies/MaxTokensTruncationStrategy";
import { ContinuityEngine } from "../src/services/continuity/ContinuityEngine";

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
let originalEvaluateAll: any;

const dbFile = "data/promptgate-test-continuity.sqlite";

describe("Gateway Continuity Integration", () => {
  const fastify = Fastify();
  let apiKey = "";
  let userId = "";
  let savedDbFile: string | undefined;
  const loggedActions: any[] = [];

  beforeAll(async () => {
    originalEvaluateAll = ContinuityEngine.prototype.evaluateAll;
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

    userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: "testuser",
      passwordHash: "dummy",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rawKey = "pg_key_cont_" + crypto.randomUUID().slice(0, 8);
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

    await db.delete(systemSettings).where(eq(systemSettings.key, "allowUnknownHostFallback"));
    await db.insert(systemSettings).values({
      key: "allowUnknownHostFallback",
      value: "true",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    unsubscribe = actionLogger.subscribeActionLogs((entry: any) => {
      loggedActions.push({
        code: entry.code || entry.params?.code,
        modelId: entry.params?.modelId,
      });
    });
  });

  let unsubscribe: (() => void) | undefined;

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
        await db.delete(routeAuthorizations).where(like(routeAuthorizations.routeId, "cont-%"));
        await db.delete(endpointRoutes).where(like(endpointRoutes.id, "cont-%"));
        await db.delete(endpoints).where(like(endpoints.id, "cont-%"));
        await db.delete(providerModels).where(like(providerModels.providerId, "cont-%"));
        await db.delete(providerApiKeys).where(like(providerApiKeys.providerId, "cont-%"));
        await db.delete(providers).where(like(providers.id, "cont-%"));
      } catch (e) {
        console.error("Cleanup error:", e);
      }
    }
    ContinuityEngine.prototype.evaluateAll = originalEvaluateAll;
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

  it("1. OpenAI non-streaming JSON continuity (A + B + C)", async () => {
    await setupProvider({
      provId: "cont-prov-1",
      name: "OpenAI JSON",
      openaiBaseUrl: "https://api.openai.com/v1",
    });
    await setupEndpointRoute({
      epId: "cont-ep-1",
      routeId: "cont-route-1",
      provId: "cont-prov-1",
      incomingProtocol: "openai",
      providerProtocol: "openai",
    });

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string, init?: any) => {
      fetchCount++;
      const reqBody = JSON.parse(init.body);
      expect(reqBody.model).toBe("test-model");

      if (fetchCount === 1) {
        expect(reqBody.messages.length).toBe(1);
        return new Response(JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "part-A" }, finish_reason: "length" }],
          usage: { prompt_tokens: 5, completion_tokens: 5 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      } else if (fetchCount === 2) {
        expect(reqBody.messages.length).toBe(3);
        expect(reqBody.messages[1].role).toBe("assistant");
        expect(reqBody.messages[1].content).toBe("part-A");
        return new Response(JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "part-B" }, finish_reason: "length" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      } else {
        expect(reqBody.messages.length).toBe(3);
        expect(reqBody.messages[1].role).toBe("assistant");
        expect(reqBody.messages[1].content).toBe("part-Apart-B");
        return new Response(JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "part-C" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 15, completion_tokens: 5 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: false },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.choices[0].message.content).toBe("part-Apart-Bpart-C");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(fetchCount).toBe(3);
  });

  it("2. stream=true, application/json fake stream continuity (A + B + C)", async () => {
    await setupProvider({
      provId: "cont-prov-2",
      name: "Fake Stream JSON",
      openaiBaseUrl: "https://api.openai.com/v1",
    });
    await setupEndpointRoute({
      epId: "cont-ep-2",
      routeId: "cont-route-2",
      provId: "cont-prov-2",
      incomingProtocol: "openai",
      providerProtocol: "openai",
    });

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string, init?: any) => {
      fetchCount++;
      const reqBody = JSON.parse(init.body);
      expect(reqBody.model).toBe("test-model");

      if (fetchCount === 1) {
        return new Response(JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "part-A" }, finish_reason: "length" }],
          usage: { prompt_tokens: 5, completion_tokens: 5 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      } else if (fetchCount === 2) {
        expect(reqBody.messages.length).toBe(3);
        expect(reqBody.messages[1].content).toBe("part-A");
        return new Response(JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "part-B" }, finish_reason: "length" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      } else {
        expect(reqBody.messages.length).toBe(3);
        expect(reqBody.messages[1].content).toBe("part-Apart-B");
        return new Response(JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "part-C" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 15, completion_tokens: 5 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    expect(response.statusCode).toBe(200);
    const lines = response.body.split("\n").filter(l => l.startsWith("data: "));
    const chunks = lines.map(l => {
      const payload = l.replace("data: ", "").trim();
      return payload === "[DONE]" ? "[DONE]" : JSON.parse(payload);
    });

    // Extract text content from chunks
    let text = "";
    let finishReason: string | null = null;
    let doneFound = false;

    for (const chunk of chunks) {
      if (chunk === "[DONE]") {
        doneFound = true;
      } else {
        if (chunk.choices?.[0]?.delta?.content) {
          text += chunk.choices[0].delta.content;
        }
        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
      }
    }

    expect(text).toBe("part-Apart-Bpart-C");
    expect(finishReason).toBe("stop");
    expect(doneFound).toBe(true);
    expect(fetchCount).toBe(3);
  });

  it("3. OpenAI real-stream continuity (A + B + C)", async () => {
    await setupProvider({
      provId: "cont-prov-3",
      name: "Real Stream OpenAI",
      openaiBaseUrl: "https://api.openai.com/v1",
    });
    await setupEndpointRoute({
      epId: "cont-ep-3",
      routeId: "cont-route-3",
      provId: "cont-prov-3",
      incomingProtocol: "openai",
      providerProtocol: "openai",
    });

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string, init?: any) => {
      fetchCount++;
      const reqBody = JSON.parse(init.body);
      expect(reqBody.stream).toBe(true);

      if (fetchCount === 1) {
        const streamText = `data: {"choices":[{"delta":{"content":"part-A"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n`;
        return new Response(streamText, { status: 200, headers: { "content-type": "text/event-stream" } });
      } else if (fetchCount === 2) {
        expect(reqBody.messages.length).toBe(3);
        expect(reqBody.messages[1].content).toBe("part-A");
        const streamText = `data: {"choices":[{"delta":{"content":"part-B"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n`;
        return new Response(streamText, { status: 200, headers: { "content-type": "text/event-stream" } });
      } else {
        expect(reqBody.messages.length).toBe(3);
        expect(reqBody.messages[1].content).toBe("part-Apart-B");
        const streamText = `data: {"choices":[{"delta":{"content":"part-C"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
        return new Response(streamText, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    expect(response.statusCode).toBe(200);
    require("fs").writeFileSync("test3_body.log", response.body);
    const lines = response.body.split("\n").filter(l => l.startsWith("data: "));
    const chunks = lines.map(l => {
      const payload = l.replace("data: ", "").trim();
      return payload === "[DONE]" ? "[DONE]" : JSON.parse(payload);
    });

    let text = "";
    let finishReason: string | null = null;
    let doneCount = 0;

    for (const chunk of chunks) {
      if (chunk === "[DONE]") {
        doneCount++;
      } else {
        if (chunk.choices?.[0]?.delta?.content) {
          text += chunk.choices[0].delta.content;
        }
        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
      }
    }

    expect(text).toBe("part-Apart-Bpart-C");
    expect(finishReason).toBe("stop");
    console.log("CHUNKS", chunks, "DONE_COUNT", doneCount);
    // As it was stitched stream, only the final [DONE] is forwarded
    expect(doneCount).toBe(1);
    expect(fetchCount).toBe(3);
  });

  it("4. Native Anthropic: bypassed and never auto-continued", async () => {
    await setupProvider({
      provId: "cont-prov-4",
      name: "Native Anthropic",
      anthropicBaseUrl: "https://api.anthropic.com",
    });
    await setupEndpointRoute({
      epId: "cont-ep-4",
      routeId: "cont-route-4",
      provId: "cont-prov-4",
      incomingProtocol: "anthropic",
      providerProtocol: "anthropic",
    });

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string, init?: any) => {
      fetchCount++;
      expect(url).toContain("api.anthropic.com");

      // Yield native Anthropic SSE events
      const sseText = [
        `event: message_start`,
        `data: {"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[],"model":"claude-3","stop_reason":null,"usage":{"input_tokens":5,"output_tokens":0}}}`,
        ``,
        `event: content_block_start`,
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
        ``,
        `event: content_block_delta`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Native Anthropic Content"}}`,
        ``,
        `event: content_block_stop`,
        `data: {"type":"content_block_stop","index":0}`,
        ``,
        `event: message_delta`,
        `data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":10}}`,
        ``,
        `event: message_stop`,
        `data: {"type":"message_stop"}`,
        ``,
      ].join("\n");

      return new Response(sseText, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    expect(response.statusCode).toBe(200);
    const bodyStr = response.body;

    // Check count of events
    const messageStartCount = (bodyStr.match(/event: message_start/g) || []).length;
    const messageStopCount = (bodyStr.match(/event: message_stop/g) || []).length;
    const contentBlockStartCount = (bodyStr.match(/event: content_block_start/g) || []).length;
    const contentBlockStopCount = (bodyStr.match(/event: content_block_stop/g) || []).length;

    expect(messageStartCount).toBe(1);
    expect(messageStopCount).toBe(1);
    expect(contentBlockStartCount).toBe(1);
    expect(contentBlockStopCount).toBe(1);
    expect(fetchCount).toBe(1);
    expect(bodyStr).toContain("max_tokens");

    // Assert action log contains "request.continuity.native_anthropic_not_retried"
    const retryLog = loggedActions.find(act => act.code === "request.continuity.native_anthropic_not_retried");
    expect(retryLog).toBeDefined();
  });

  it("5. Hard loop cycle limits (continuityCycles >= MAX_CONTINUITY_CYCLES)", async () => {
    ContinuityEngine.prototype.evaluateAll = async function(context) {
      for (const strat of (this as any).strategies) {
        strat.maxRetries = 10;
      }
      return originalEvaluateAll.call(this, context);
    };
    await setupProvider({
      provId: "cont-prov-5",
      name: "JSON Limit",
      openaiBaseUrl: "https://api.openai.com/v1",
    });
    await setupEndpointRoute({
      epId: "cont-ep-5",
      routeId: "cont-route-5",
      provId: "cont-prov-5",
      incomingProtocol: "openai",
      providerProtocol: "openai",
    });

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string, init?: any) => {
      fetchCount++;
      // Upstream permanently returns length finish reason
      return new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: `part-${fetchCount}` }, finish_reason: "length" }],
        usage: { prompt_tokens: 5, completion_tokens: 5 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: false },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // Max continuity cycles is 5, meaning we fetch 1 (initial) + 5 (retries) = 6 fetches total
    expect(fetchCount).toBe(6);
    expect(body.choices[0].message.content).toBe("part-1part-2part-3part-4part-5part-6");
    expect(body.choices[0].finish_reason).toBe("length");

    // Assert logAction has request.continuity.exhausted
    const exhaustedLog = loggedActions.find(act => act.code === "request.continuity.exhausted");
    expect(exhaustedLog).toBeDefined();
  });
});
