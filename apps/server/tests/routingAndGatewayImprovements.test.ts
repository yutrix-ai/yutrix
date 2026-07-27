import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq, sql } from "drizzle-orm";
import { estimateMultimodalInputUsage } from "../src/routes/gateway/inputTokenLimit";
import { isGeneratedToolContinuationMessage } from "../src/utils/chatTurnsDetector";

const testDbPath = "data/promptgate_test_routing.sqlite";
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

const getResolvedDbPath = () => {
  if (process.cwd().endsWith("server")) {
    return path.join(process.cwd(), "../../", testDbPath);
  }
  return path.join(process.cwd(), testDbPath);
};

describe("PromptGate Routing & Gateway Improvements Integration Tests", () => {
  const fastify = Fastify();
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
    } = await import("../src/db/schema"));
    ({ encryptText } = await import("../src/utils/crypto"));
    gatewayRoutes = (await import("../src/routes/gateway")).default;

    const migrationsFolder = path.resolve(
      process.cwd(),
      process.cwd().endsWith("server") ? "./drizzle" : "apps/server/drizzle",
    );
    await migrate(db, { migrationsFolder });
    await bootstrap();

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

    await db.delete(users).where(eq(users.username, "testuser"));

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
  });

  afterAll(async () => {
    await fastify.close();
    const resolvedPath = getResolvedDbPath();
    if (fs.existsSync(resolvedPath)) {
      try { fs.unlinkSync(resolvedPath); } catch (e) {}
    }
  });

  describe("Base64 Token Estimation", () => {
    it("verify estimateMultimodalInputUsage ignores base64 size and adds flat 4096 tokens per image", async () => {
      const bodySmall = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "image_url", image_url: { url: "data:image/png;base64,123" } }
            ]
          }
        ]
      };

      const bodyLarge = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "image_url", image_url: { url: "data:image/png;base64," + "a".repeat(1024 * 1024) } } // 1MB image
            ]
          }
        ]
      };

      const estSmall = await estimateMultimodalInputUsage({ body: bodySmall });
      const estLarge = await estimateMultimodalInputUsage({ body: bodyLarge });

      expect(estSmall.imageCount).toBe(1);
      expect(estLarge.imageCount).toBe(1);
      expect(estSmall.imageTokens).toBe(4096);
      expect(estLarge.imageTokens).toBe(4096);
      expect(estLarge.textTokens).toBe(estSmall.textTokens);
      expect(estLarge.totalTokens).toBe(estSmall.totalTokens);
    });
  });

  describe("Continuation Turn Detection", () => {
    it("identifies continuation when tool results and cache controls are present", () => {
      const msgContinuation = {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "1", content: "success" },
          { type: "text", text: "  ", cache_control: { type: "ephemeral" } }
        ]
      };
      const msgRealUser = {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "1", content: "success" },
          { type: "text", text: "please change the color to red" }
        ]
      };

      expect(isGeneratedToolContinuationMessage(msgContinuation)).toBe(true);
      expect(isGeneratedToolContinuationMessage(msgRealUser)).toBe(false);
    });
  });

  describe("Fastify Gateway Integration & Capacity Retry", () => {
    it("pins the API key and capacity-retries up to 2 times on OpenRouter capacity errors", async () => {
      const provId = "openrouter-prov";
      await db.delete(providers).where(eq(providers.id, provId));
      await db.insert(providers).values({
        id: provId,
        name: "openrouter-prov",
        enabled: true,
        openaiBaseUrl: "https://openrouter.ai/api/v1",
        concurrencyLimit: 5,
        timeoutMs: 5000,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const keyId = "key-openrouter-active";
      await db.delete(providerApiKeys).where(eq(providerApiKeys.id, keyId));
      await db.insert(providerApiKeys).values({
        id: keyId,
        providerId: provId,
        keyName: "OpenRouter API Key",
        keyEncrypted: encryptText("encrypted-openrouter-key"),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const modelId = "openrouter/nemotron-3-ultra";
      await db.delete(providerModels).where(eq(providerModels.providerId, provId));
      await db.insert(providerModels).values({
        id: crypto.randomUUID(),
        providerId: provId,
        modelId: modelId,
        displayName: "Nemotron 3",
        enabled: true,
        active: true,
        maxOutputTokens: 100000,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const epId = "ep-test-routing";
      await db.delete(endpoints).where(eq(endpoints.id, epId));
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
      await db.delete(endpointRoutes).where(eq(endpointRoutes.endpointId, epId));
      await db.insert(endpointRoutes).values({
        id: routeId,
        endpointId: epId,
        routeName: "gateway-route",
        modelId: modelId,
        providerId: provId,
        retryCount: 0,
        fallbackEnabled: false,
        strategyRoutingEnabled: true,
        strategyRoutingRules: JSON.stringify([
          { taskType: "code", providerId: provId, modelId: modelId, enabled: true }
        ]),
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
      const authorizationHeaders: string[] = [];

      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        fetchCount++;
        const headers = init?.headers as Record<string, string> | undefined;
        authorizationHeaders.push(headers?.Authorization || "");

        if (fetchCount < 3) {
          return new Response(
            JSON.stringify({
              error: {
                message: "Provider capacity exhausted resource exhausted (79/32) local limit exceeded",
                type: "provider_overloaded"
              }
            }),
            { status: 503, headers: { "content-type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 12345,
            model: modelId,
            choices: [
              { index: 0, message: { role: "assistant", content: "Here is your completed code snippet!" }, finish_reason: "stop" }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
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
          messages: [{ role: "user", content: "write a binary search" }],
          stream: false,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchCount).toBe(3);
      expect(authorizationHeaders.length).toBe(3);
      expect(authorizationHeaders[0]).toBe(authorizationHeaders[1]);
      expect(authorizationHeaders[1]).toBe(authorizationHeaders[2]);

      const payload = JSON.parse(response.body);
      expect(payload.choices[0].message.content).toContain("completed code snippet");
    });
  });
});
