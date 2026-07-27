import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { eq, like } from "drizzle-orm";
import { resolveProviderAdapter } from "../src/routes/gateway/providerAdapters/registry";
import { transparentAdapter } from "../src/routes/gateway/providerAdapters/transparentAdapter";
import { ProviderAdapterContext } from "../src/routes/gateway/providerAdapters/types";

let db: any;
let apiKeys: any, endpoints: any, endpointRoutes: any, providerApiKeys: any, subdomains: any;
let providerModels: any, providers: any, routeAuthorizations: any, users: any;
let gatewayRoutes: any;
let encryptText: any;

describe("Provider Adapter Default Isolation E2E Matrix", () => {
  const fastify = Fastify();
  let apiKey = "";
  let userId = "";
  let globalEpId = "";

  beforeAll(async () => {
    const dbFilePath = path.join(process.cwd(), "data/promptgate-test-isolation.sqlite");
    if (fs.existsSync(dbFilePath)) {
      try { fs.unlinkSync(dbFilePath); } catch (e) { console.error("Cleanup error unlinking:", e); }
    }

    process.env.DB_FILE = "data/promptgate-test-isolation.sqlite";
    const { db: importedDb } = await import("../src/db");
    db = importedDb;

    const { migrate } = await import("drizzle-orm/libsql/migrator");
    const migrationsFolder = path.resolve(
      process.cwd(),
      process.cwd().endsWith("server") ? "./drizzle" : "apps/server/drizzle",
    );
    await migrate(db, { migrationsFolder });

    const { bootstrap } = await import("../src/bootstrap");
    await bootstrap();

    ({ apiKeys, endpoints, endpointRoutes, providerApiKeys, providerModels, providers, routeAuthorizations, users, subdomains } = await import("../src/db/schema"));
    gatewayRoutes = (await import("../src/routes/gateway")).default;
    ({ encryptText } = await import("../src/utils/crypto"));

    fastify.register(gatewayRoutes);
    await fastify.ready();

    userId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, username: "isolation_user_" + userId, passwordHash: "dummy", role: "user", status: "active", createdAt: new Date(), updatedAt: new Date() });

    const rawKey = "pg_key_iso_" + crypto.randomBytes(16).toString("hex");
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    await db.insert(apiKeys).values({ id: crypto.randomUUID(), userId, name: "ISO Key", keyHash, keyPrefix: rawKey.substring(0, 12), status: "active", createdAt: new Date(), updatedAt: new Date() });
    apiKey = rawKey;

    globalEpId = "iso-global-ep-" + crypto.randomUUID();
    await db.delete(endpoints); // clear endpoints inserted by bootstrap
    await db.insert(endpoints).values({ id: globalEpId, userId, name: "EP", path: "/v1/chat/completions", status: "active", createdAt: new Date(), updatedAt: new Date(), incomingProtocol: "openai", enabled: true });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (db && userId) {
      try {
        await db.delete(routeAuthorizations).where(eq(routeAuthorizations.userId, userId));
        await db.delete(endpointRoutes).where(like(endpointRoutes.providerId, "iso-prov%"));
        await db.delete(endpoints).where(eq(endpoints.userId, userId));
        await db.delete(subdomains).where(like(subdomains.id, "iso-sub%"));
        await db.delete(providerModels).where(like(providerModels.providerId, "iso-prov%"));
        await db.delete(providerApiKeys).where(like(providerApiKeys.providerId, "iso-prov%"));
        await db.delete(providers).where(like(providers.id, "iso-prov%"));
        await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
        await db.delete(users).where(eq(users.id, userId));
      } catch (e) {
        console.error("Cleanup error:", e);
      }
    }
    await fastify.close();

    const dbFilePath = path.join(process.cwd(), "data/promptgate-test-isolation.sqlite");
    if (fs.existsSync(dbFilePath)) {
      try { fs.unlinkSync(dbFilePath); } catch (e) { console.error("Cleanup error unlinking:", e); }
    }
  });

  async function createProvider(baseUrl: string, protocol: string, modelId: string) {
    const uniqueId = crypto.randomUUID().substring(0, 8);
    const provId = `iso-prov-${uniqueId}`;
    const subId = `iso-sub-${uniqueId}`;
    const hostname = `iso-host-${uniqueId}.promptgate.local`;

    await db.insert(subdomains).values({ id: subId, userId, name: `Sub ${uniqueId}`, hostname, enabled: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(providers).values({ id: provId, name: `ISO Provider ${uniqueId}`, openaiBaseUrl: baseUrl, enabled: true, concurrencyLimit: 10, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(providerApiKeys).values({ id: provId + "-key", providerId: provId, keyEncrypted: encryptText("sk-dummy"), status: "active", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(providerModels).values({ id: provId + "-model", providerId: provId, modelId, displayName: "Model", enabled: true, active: true, createdAt: new Date() });
    await db.insert(endpointRoutes).values({ id: provId + "-route", subdomainId: subId, endpointId: globalEpId, name: "Route", providerId: provId, providerProtocol: protocol, modelId, strategyRoutingEnabled: false, status: "active", weight: 100, enabled: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(routeAuthorizations).values({ id: provId + "-auth", routeId: provId + "-route", userId, createdAt: new Date() });
    return hostname;
  }

  const testUrls = [
    { name: "Alibaba", url: "https://dashscope.aliyuncs.com/compatible-mode/v1", protocol: "openai" },
    { name: "Tencent", url: "https://api.hunyuan.cloud.tencent.com/v1", protocol: "openai" },
    { name: "OpenAI", url: "https://api.openai.com/v1", protocol: "openai" },
    { name: "Anthropic", url: "https://api.anthropic.com", protocol: "anthropic" },
    { name: "Internal", url: "https://llm.internal.example/v1", protocol: "openai" },
    { name: "Custom", url: "https://gateway.example.com/api/v1", protocol: "openai" },
  ];

  const testModels = [
    "qwen-max",
    "hunyuan-pro",
    "gemini-2.5-flash",
    "gemma-3",
    "google/gemini-2.5-pro",
    "nvidia/nemotron-3-ultra-550b-a55b",
    "anthropic/claude-3-5-sonnet",
    "openai/gpt-4o",
  ];

  it("1. 静态 Context 映射矩阵：所有组合皆为 transparent 适配器", () => {
    for (const tUrl of testUrls) {
      for (const model of testModels) {
        const parsed = new URL(tUrl.url);
        const ctx: ProviderAdapterContext = {
          providerId: "test-p",
          providerName: "Test Provider",
          providerProtocol: tUrl.protocol,
          rawBaseUrl: tUrl.url,
          normalizedBaseUrl: tUrl.url,
          hostname: parsed.hostname,
          pathname: parsed.pathname,
          modelId: model,
          incomingProtocol: "openai",
          requestPath: "/v1/chat/completions",
        };
        expect(resolveProviderAdapter(ctx).id).toBe("transparent");
      }
    }
  });

  it("2. Transparent 适配器 API 限制：不可执行任何专属 Hooks", () => {
    const state = transparentAdapter.createAttemptState ? transparentAdapter.createAttemptState({} as any) : {};
    expect(transparentAdapter.transformStreamChunk!({ choices: [{ delta: { content: "x" } }] }, state, {} as any)).toBe(false);

    const originalRes = { choices: [{ message: { content: "hello" } }] };
    const resCopy = JSON.parse(JSON.stringify(originalRes));
    expect(transparentAdapter.transformNonStreamResponse!(resCopy, {} as any)).toBe(false);
    expect(resCopy).toStrictEqual(originalRes);

    const obsRes = transparentAdapter.observeStreamChunk!({ choices: [{ delta: { content: "x" } }] }, state, {} as any);
    expect(obsRes).toBeUndefined();

    const obsNonStream = transparentAdapter.observeNonStreamResponse!({ choices: [{ message: { content: "hello" } }] }, state, {} as any);
    expect(obsNonStream).toBeUndefined();
  });

  for (const tUrl of testUrls) {
    describe(`URL Group: ${tUrl.name}`, () => {
      for (const model of testModels) {
        it(`E2E check: ${model} is fully isolated`, async () => {
          const hostname = await createProvider(tUrl.url, tUrl.protocol, model);

          let capturedUrl = "";
          let capturedBody: any = null;
          let capturedHeaders: Record<string, string> = {};

          const payload = {
            model,
            messages: [{ role: "user", content: "hello" }],
            temperature: 0.7,
            stream: false
          };

          const mockJsonResponse = {
            choices: [{
              message: { role: "assistant", content: "response content" },
              finish_reason: "stop"
            }],
            usage: { prompt_tokens: 10, completion_tokens: 20 }
          };

          vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
            capturedUrl = url;
            capturedBody = JSON.parse(String(init?.body || "{}"));
            capturedHeaders = Object.fromEntries(
              Object.entries(init?.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
            );
            return new Response(JSON.stringify(mockJsonResponse), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          });

          const response = await fastify.inject({
            method: "POST",
            url: "/v1/chat/completions",
            headers: {
              host: hostname,
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
              "cookie": "my-session-cookie",
              "x-custom-client-header": "custom-val"
            },
            payload
          });

          expect(response.statusCode).toBe(200);
          expect(JSON.parse(response.body)).toStrictEqual(mockJsonResponse);

          // 验证请求 URL 保持原规则
          expect(capturedUrl).toContain(new URL(tUrl.url).hostname);

          // 验证请求 body 深度相等
          expect(capturedBody.messages).toStrictEqual(payload.messages);
          expect(capturedBody.temperature).toBe(payload.temperature);

          // 验证 headers 没有增加无关的客户端透传头，且保留基础认证头
          expect(capturedHeaders["cookie"]).toBeUndefined();
          expect(capturedHeaders["x-custom-client-header"]).toBeUndefined();
          expect(capturedHeaders["content-type"]).toBe("application/json");
          if (tUrl.protocol === "anthropic") {
            expect(capturedHeaders["x-api-key"]).toBe("sk-dummy");
            expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
          } else {
            expect(capturedHeaders["authorization"]).toBe("Bearer sk-dummy");
          }
        });

        it(`SSE Streaming check: ${model} bytes are identical`, async () => {
          const hostname = await createProvider(tUrl.url, tUrl.protocol, model);

          const sseStreamLines = [
            `data: ${JSON.stringify({ id: "1", choices: [{ delta: { content: "Hello " } }] })}`,
            `data: ${JSON.stringify({ id: "2", choices: [{ delta: { content: "world" } }] })}`,
            `data: [DONE]`
          ];
          const originalSse = sseStreamLines.map(l => l + "\n").join("") + "\n";

          vi.stubGlobal("fetch", async () => {
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
              start(ctrl) {
                ctrl.enqueue(encoder.encode(originalSse));
                ctrl.close();
              }
            });
            return new Response(stream, {
              status: 200,
              headers: { "content-type": "text/event-stream" }
            });
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
              model,
              messages: [{ role: "user", content: "stream hello" }],
              stream: true
            }
          });

          // SSE 字节级原样
          expect(response.body).toContain('data: {"id":"1","choices":[{"delta":{"content":"Hello "}}]}');
          expect(response.body).toContain('data: {"id":"2","choices":[{"delta":{"content":"world"}}]}');
          
          
        });
      }
    });
  }

  it("3. 阿里 URL + Gemini模型 + extra_content.google.thought 输出逐字节保持原样", async () => {
    const hostname = await createProvider("https://dashscope.aliyuncs.com/compatible-mode/v1", "openai", "gemini-2.5-flash");

    const originalSse = `data: ${JSON.stringify({
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      choices: [{
        index: 0,
        delta: {
          content: "<thought>thinking",
          extra_content: { google: { thought: true } }
        },
        finish_reason: null
      }]
    })}\n\n`;

    vi.stubGlobal("fetch", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(encoder.encode(originalSse));
          ctrl.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
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
        messages: [{ role: "user", content: "test thought" }],
        stream: true
      }
    });

    expect(response.body).toContain('data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"<thought>thinking","extra_content":{"google":{"thought":true}}},"finish_reason":null}]}');
    
    
  });

  it("4. 腾讯 URL + reasoning_details + finish_reason:error 保持改造前 Default语义，不触发 OpenRouter terminalError", async () => {
    const hostname = await createProvider("https://api.hunyuan.cloud.tencent.com/v1", "openai", "hunyuan-pro");

    const originalSse = `data: ${JSON.stringify({
      id: "chatcmpl-456",
      object: "chat.completion.chunk",
      choices: [{
        index: 0,
        delta: { content: "" },
        finish_reason: "error"
      }],
      error: { code: 500, message: "Tencent internal error" }
    })}\n\n`;

    vi.stubGlobal("fetch", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(encoder.encode(originalSse));
          ctrl.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
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
        model: "hunyuan-pro",
        messages: [{ role: "user", content: "test error" }],
        stream: true
      }
    });

    expect(response.body).toContain('data: {"id":"chatcmpl-456","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}],"error":{"code":500,"message":"Tencent internal error"}}');
    
    
  });
});
