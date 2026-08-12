import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { parseAndNormalizeUrl } from "../src/routes/gateway/providerAdapters/urlMatcher";

import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";

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
let encryptText: any;

const dbFile = "data/promptgate-test-openrouter-gw.sqlite";

describe("OpenRouter Gateway Integration", () => {
  const fastify = Fastify();
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
      systemSettings,
      users,
    } = await import("../src/db/schema"));
    gatewayRoutes = (await import("../src/routes/gateway")).default;
    ({ encryptText } = await import("../src/utils/crypto"));

    // Register gateway routes
    fastify.register(gatewayRoutes);
    await fastify.ready();

    // Configure system settings fallback
    await db.delete(systemSettings).where(eq(systemSettings.key, "allowUnknownHostFallback"));
    await db.insert(systemSettings).values({
      key: "allowUnknownHostFallback",
      value: "true",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create a test user if not exists
    userId = crypto.randomUUID();
    const uniqueSuffix = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: "or_integration_user_" + uniqueSuffix,
      passwordHash: "dummy",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create a test API key for the user
    const rawKey = "pg_key_or_test_" + crypto.randomBytes(16).toString("hex");
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      userId: userId,
      name: "OR Integration Key",
      keyHash: keyHash,
      keyPrefix: rawKey.substring(0, 12),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    apiKey = rawKey;

    // Register OpenRouter Provider
    const provId = "or-integration-prov";
    await db.insert(providers).values({
      id: provId,
      name: "OpenRouter Test Provider",
      openaiBaseUrl: "https://openrouter.ai/api/v1",
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Register API key
    await db.insert(providerApiKeys).values({
      id: "or-integration-key-id",
      providerId: provId,
      keyEncrypted: encryptText("sk-or-dummy"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Register Model tencent/hy3
    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: provId,
      modelId: "tencent/hy3",
      displayName: "tencent/hy3",
      enabled: true,
      createdAt: new Date(),
    });

    // Register Endpoint
    const epId = "or-integration-ep";
    await db.insert(endpoints).values({
      id: epId,
      userId: userId,
      name: "OR Endpoint",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Register Endpoint Route
    await db.insert(endpointRoutes).values({
      id: "or-integration-route",
      endpointId: epId,
      name: "OR Route",
      providerId: provId,
      providerProtocol: "openai",
      modelId: "tencent/hy3",
      strategyRoutingEnabled: false,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Authorize route
    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: "or-integration-route",
      userId: userId,
      createdAt: new Date(),
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    // Cleanup sqlite
    await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, "or-integration-route"));
    await db.delete(endpointRoutes).where(eq(endpointRoutes.id, "or-integration-route"));
    await db.delete(endpoints).where(eq(endpoints.id, "or-integration-ep"));
    await db.delete(providerModels).where(eq(providerModels.providerId, "or-integration-prov"));
    await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, "or-integration-prov"));
    await db.delete(providers).where(eq(providers.id, "or-integration-prov"));
    await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("applies OpenRouter request policy and forwards assistant reasoning_details", async () => {
    let capturedUpstreamBody: any = null;

    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      capturedUpstreamBody = JSON.parse(String(init?.body || "{}"));
      return new Response(
        JSON.stringify({
          id: "chatcmpl-or-int",
          object: "chat.completion",
          model: "tencent/hy3",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "integrated response",
                reasoning: "thinking text",
                reasoning_details: [{ type: "text", text: "thought text" }]
              },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 }
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
        model: "tencent/hy3",
        messages: [
          {
            role: "assistant",
            content: "previous text",
            reasoning: "previous thinking",
            reasoning_details: [{ type: "text", text: "previous thought details" }]
          },
          {
            role: "user",
            content: "hello",
            reasoning: "should be deleted"
          }
        ],
        stream: false
      }
    });

    expect(response.statusCode).toBe(200);
    const respBody = JSON.parse(response.body);

    // Verify response contains the reasoning details
    expect(respBody.choices[0].message.reasoning).toBe("thinking text");
    expect(respBody.choices[0].message.reasoning_details).toStrictEqual([{ type: "text", text: "thought text" }]);

    // Verify upstream request body had reasoning details preserved in assistant history but deleted in user history
    expect(capturedUpstreamBody).toBeDefined();
    expect(capturedUpstreamBody.messages[0].reasoning).toBe("previous thinking");
    expect(capturedUpstreamBody.messages[0].reasoning_details).toStrictEqual([{ type: "text", text: "previous thought details" }]);
    expect(capturedUpstreamBody.messages[1].reasoning).toBeUndefined();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await fastify.close();
    await closeAndCleanup(client, dbFile);
  });
});
