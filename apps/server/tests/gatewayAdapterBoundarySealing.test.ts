import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { initTestDatabase, cleanupTestDatabaseFiles } from "./helpers/testDatabase";

let db: any;
let apiKeys: any, endpoints: any, endpointRoutes: any, providerApiKeys: any, subdomains: any;
let providerModels: any, providers: any, routeAuthorizations: any, users: any, chatLogs: any;
let gatewayRoutes: any;
let encryptText: any;

describe("Gateway Adapter Boundary Sealing & Fake Stream Regression Test Suite", () => {
  const fastify = Fastify();
  let apiKey = "";
  let userId = "";
  let globalEpId = "";
  let globalAnthEpId = "";
  let oldDbFile: string | undefined;
  const dbFilePath = "data/promptgate-test-sealing.sqlite";

  beforeAll(async () => {
    oldDbFile = process.env.DB_FILE;

    // Use test database helper
    await initTestDatabase({ dbFilePath });

    ({
      apiKeys,
      endpoints,
      endpointRoutes,
      providerApiKeys,
      providerModels,
      providers,
      routeAuthorizations,
      users,
      subdomains,
      chatLogs
    } = await import("../src/db/schema"));

    const { db: importedDb } = await import("../src/db");
    db = importedDb;

    gatewayRoutes = (await import("../src/routes/gateway")).default;
    ({ encryptText } = await import("../src/utils/crypto"));
    await import("../src/services/chatLogService");

    fastify.register(gatewayRoutes);
    await fastify.ready();

    userId = crypto.randomUUID();

    // Clear dynamic tables to isolate tests from previous dirty database states
    await db.delete(routeAuthorizations);
    await db.delete(endpointRoutes);
    await db.delete(endpoints);
    await db.delete(subdomains);
    await db.delete(providerModels);
    await db.delete(providerApiKeys);
    await db.delete(providers);
    await db.delete(apiKeys);
    await db.delete(users);
    await db.delete(chatLogs);

    globalEpId = "seal-global-ep-" + crypto.randomUUID();
    await db.insert(endpoints).values({
      id: globalEpId,
      userId,
      name: "EP-" + globalEpId,
      path: "/v1/chat/completions",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      incomingProtocol: "openai",
      enabled: true
    });

    globalAnthEpId = "seal-global-anth-ep-" + crypto.randomUUID();
    await db.insert(endpoints).values({
      id: globalAnthEpId,
      userId,
      name: "Anth EP-" + globalAnthEpId,
      path: "/v1/messages",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      incomingProtocol: "anthropic",
      enabled: true
    });

    // Now insert our test user and api key
    await db.insert(users).values({
      id: userId,
      username: "sealing_user_" + userId,
      passwordHash: "dummy",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const rawKey = "pg_key_seal_" + crypto.randomBytes(16).toString("hex");
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      userId,
      name: "Seal Key",
      keyHash,
      keyPrefix: rawKey.substring(0, 12),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date()
    });
    apiKey = rawKey;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await fastify.close();

    // Restore env
    if (oldDbFile) {
      process.env.DB_FILE = oldDbFile;
    } else {
      delete process.env.DB_FILE;
    }

    // Clean SQLite files
    await cleanupTestDatabaseFiles(dbFilePath);
  });

  let counter = 0;
  async function createProvider(baseUrl: string, protocol: string, modelId: string, customProviderName?: string, isAnthropicInbound = false) {
    counter++;
    const uuid = crypto.randomUUID().substring(0, 8);
    const provId = `seal-prov-${counter}-${uuid}`;
    const subId = `seal-sub-${counter}-${uuid}`;
    const hostname = `seal-host-${counter}-${uuid}.promptgate.local`;

    await db.insert(subdomains).values({
      id: subId,
      userId,
      name: `Sub ${counter}-${uuid}`,
      hostname,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await db.insert(providers).values({
      id: provId,
      name: customProviderName || `Seal Provider ${counter}`,
      openaiBaseUrl: baseUrl,
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await db.insert(providerApiKeys).values({
      id: provId + "-key",
      providerId: provId,
      keyEncrypted: encryptText("sk-dummy"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await db.insert(providerModels).values({
      id: provId + "-model",
      providerId: provId,
      modelId,
      displayName: "Model",
      enabled: true,
      active: true,
      createdAt: new Date()
    });

    const routeId = `seal-route-${counter}-${uuid}`;
    await db.insert(endpointRoutes).values({
      id: routeId,
      subdomainId: subId,
      endpointId: isAnthropicInbound ? globalAnthEpId : globalEpId,
      name: `Route ${counter}`,
      providerId: provId,
      providerProtocol: protocol,
      modelId,
      strategyRoutingEnabled: false,
      status: "active",
      weight: 100,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await db.insert(routeAuthorizations).values({
      id: `seal-auth-${counter}-${uuid}`,
      routeId,
      userId,
      createdAt: new Date()
    });

    return hostname;
  }

  // =========================================================================
  // 二、堵住 Google compatibility 绕过 Registry
  // =========================================================================

  it("1. Transparent URL with Google Compatible Proxy: request is strictly unchanged", async () => {
    const hostname = await createProvider("https://gateway.example.com/v1", "openai", "custom-model", "Google Compatible Proxy");

    let upstreamBody: any = null;
    let fetchedUrl = "";

    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchedUrl = url;
      upstreamBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const payload = {
      model: "custom-model",
      messages: [{ role: "user", content: "hi" }],
      stream_options: { include_usage: true },
      max_tokens: 16384,
      tools: [{
        type: "function",
        function: {
          name: "complex",
          parameters: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false
          }
        }
      }]
    };

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        host: hostname,
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(upstreamBody.stream_options).toEqual({ include_usage: true });
    expect(upstreamBody.max_tokens).toBe(16384);
    expect(upstreamBody.tools[0].function.parameters.$schema).toBeDefined();
    expect(fetchedUrl).toBe("https://gateway.example.com/v1/chat/completions");
  });

  it("2. Transparent URL with evilgoogleapis.com: remains transparent & OpenAI format", async () => {
    const hostname = await createProvider("https://evilgoogleapis.com/v1", "openai", "gemini-2.5-flash");

    let fetchedUrl = "";
    let upstreamBody: any = null;

    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchedUrl = url;
      upstreamBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        host: hostname,
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      payload: {
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "test" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(fetchedUrl).toBe("https://evilgoogleapis.com/v1/chat/completions");
    expect(upstreamBody.messages).toBeDefined();
    expect(fetchedUrl).not.toContain("generateContent");
  });

  it("3. Alibaba URL with Gemini via Alibaba: remains unchanged", async () => {
    const hostname = await createProvider("https://api.aliyun.com/v1", "openai", "gemini-2.5", "Gemini via Alibaba");

    let upstreamBody: any = null;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      upstreamBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const payload = {
      model: "gemini-2.5",
      messages: [{ role: "user", content: "hi" }],
      stream_options: { include_usage: true },
      max_tokens: 16000,
      tools: [{
        type: "function",
        function: {
          name: "bash",
          parameters: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false
          }
        }
      }]
    };

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        host: hostname,
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(upstreamBody.stream_options).toEqual({ include_usage: true });
    expect(upstreamBody.max_tokens).toBe(16000);
    expect(upstreamBody.tools[0].function.parameters.$schema).toBeDefined();
  });

  // =========================================================================
  // 三、修复 JSON → fake stream 的协议来源
  // =========================================================================

  it("Scenario A: Anthropic client + Ali OpenAI provider (transparent) -> returns complete Anthropic SSE", async () => {
    const hostname = await createProvider("https://dashscope.aliyuncs.com/compatible-mode/v1", "openai", "qwen-plus", undefined, true);

    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      return new Response(JSON.stringify({
        id: "chatcmpl-qwen1",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "Hello from Qwen!"
          },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 5, completion_tokens: 10 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        host: hostname,
        "x-api-key": apiKey,
        "content-type": "application/json"
      },
      payload: {
        model: "qwen-plus",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        stream: true
      }
    });

    expect(response.statusCode).toBe(200);
    const bodyText = response.body;
    expect(bodyText).toContain("event: message_start");
    expect(bodyText).toContain("event: content_block_start");
    expect(bodyText).toContain("Hello from Qwen!");
    expect(bodyText).toContain("event: message_stop");
  });

  it("Scenario B: Anthropic client + OpenRouter Native Anthropic -> Thinking/redacted/signature preserved", async () => {
    const hostname = await createProvider("https://openrouter.ai/api/v1", "anthropic", "anthropic/claude-3-opus", "OpenRouter Native", true);

    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      return new Response(JSON.stringify({
        id: "msg_or_b",
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Deep thought details" },
          { type: "redacted_thinking" },
          { type: "text", text: "Final answer" }
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 25 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        host: hostname,
        "x-api-key": apiKey,
        "content-type": "application/json"
      },
      payload: {
        model: "anthropic/claude-3-opus",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        stream: true
      }
    });

    expect(response.statusCode).toBe(200);
    const bodyText = response.body;
    expect(bodyText).toContain('"type":"thinking"');
    expect(bodyText).toContain('"thinking":"Deep thought details"');
    expect(bodyText).toContain('"type":"redacted_thinking"');
    expect(bodyText).toContain('"text":"Final answer"');
  });

  // =========================================================================
  // 六、消费非流式 observation 审计测试
  // =========================================================================

  it("Non-stream observation audit logs: saves reasoningText containing thinking block, ignoring redacted", async () => {
    const hostname = await createProvider("https://openrouter.ai/api/v1", "anthropic", "anthropic/claude-3.5-sonnet", "OpenRouter For Audit", true);

    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      return new Response(JSON.stringify({
        id: "msg_audit_1",
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "My deep reasoning thoughts" },
          { type: "redacted_thinking" },
          { type: "text", text: "Hello response" }
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 20 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await db.delete(chatLogs);

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        host: hostname,
        "x-api-key": apiKey,
        "content-type": "application/json"
      },
      payload: {
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "audit test" }],
        max_tokens: 100,
        stream: false
      }
    });

    expect(response.statusCode).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 300));

    const logs = await db.select().from(chatLogs);
    expect(logs.length).toBe(1);
    expect(logs[0].outputText).toContain("<think>My deep reasoning thoughts</think>");
    expect(logs[0].outputText).not.toContain("redacted");
  });

  // =========================================================================
  // 七、修复 OpenAI 连续截断累计文本丢失
  // =========================================================================

  it("accumulates text across consecutive length truncations for non-streaming response", async () => {
    let fetchCount = 0;
    const bodies: any[] = [];

    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchCount++;
      bodies.push(JSON.parse(init?.body as string));

      if (fetchCount === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "part-A" }, finish_reason: "length" }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      } else if (fetchCount === 2) {
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "part-B" }, finish_reason: "length" }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      } else {
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "part-C" }, finish_reason: "stop" }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });

    const hostname = await createProvider("https://api.openai.com/v1", "openai", "openai/gpt-4", "OpenAI For Truncation");

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        host: hostname,
        "x-api-key": apiKey,
        "content-type": "application/json"
      },
      payload: {
        model: "openai/gpt-4",
        messages: [{ role: "user", content: "Tell me a story" }],
        stream: false
      }
    });

    expect(response.statusCode).toBe(200);
    expect(fetchCount).toBe(3);

    // Assert second fetch body contains only part-A from previous
    const req2Messages = bodies[1].messages;
    expect(req2Messages[req2Messages.length - 2].content).toBe("part-A");

    // Assert third fetch body contains part-A + part-B
    const req3Messages = bodies[2].messages;
    expect(req3Messages[req3Messages.length - 2].content).toBe("part-Apart-B");

    // Assert final combined result
    const resultBody = JSON.parse(response.body);
    expect(resultBody.choices[0].message.content).toBe("part-Apart-Bpart-C");
  });

});
