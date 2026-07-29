import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq } from "drizzle-orm";
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

const dbFile = "data/promptgate-test-or-anthropic.sqlite";

describe("OpenRouter Anthropic Native Stream Integration", () => {
  const fastify = Fastify();
  let apiKey = "";
  let userId = "";
  let provId = "";
  let keyId = "";
  let epId = "";
  let routeId = "";
  let savedDbFile: string | undefined;

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
      username: "or_anthropic_user_" + uniqueSuffix,
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
      name: "OR Anthropic Integration Key",
      keyHash: keyHash,
      keyPrefix: rawKey.substring(0, 12),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    apiKey = rawKey;

    // Register OpenRouter Provider (unique per run to avoid parallel test collisions)
    const suffix = crypto.randomUUID().slice(0, 8);
    provId = `or-anthropic-prov-${suffix}`;
    keyId = `or-anthropic-key-${suffix}`;
    epId = `or-anthropic-ep-${suffix}`;
    routeId = `or-anthropic-route-${suffix}`;

    await db.insert(providers).values({
      id: provId,
      name: "OpenRouter Test Provider",
      openaiBaseUrl: "https://openrouter.ai/api/v1",
      // Native Anthropic surface requires anthropicBaseUrl (or anthropic-bound route URL).
      anthropicBaseUrl: "https://openrouter.ai/api/v1",
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Register API key
    await db.insert(providerApiKeys).values({
      id: keyId,
      providerId: provId,
      keyEncrypted: encryptText("sk-or-dummy"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Register Model anthropic/claude-3.5-sonnet
    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: provId,
      modelId: "anthropic/claude-3.5-sonnet",
      displayName: "Claude 3.5 Sonnet",
      enabled: true,
      createdAt: new Date(),
    });

    // Register Endpoint
    await db.insert(endpoints).values({
      id: epId,
      userId: userId,
      name: "OR Anthropic Endpoint",
      path: "/v1/messages",
      incomingProtocol: "anthropic",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Register Endpoint Route — anthropic protocol selects anthropicBaseUrl → native /messages
    await db.insert(endpointRoutes).values({
      id: routeId,
      endpointId: epId,
      name: "OR Route",
      providerId: provId,
      providerProtocol: "anthropic",
      modelId: "anthropic/claude-3.5-sonnet",
      strategyRoutingEnabled: false,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Authorize route
    await db.insert(routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId,
      userId: userId,
      createdAt: new Date(),
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await fastify.close();
    await closeAndCleanup(client, dbFile);
    if (savedDbFile !== undefined) {
      process.env.DB_FILE = savedDbFile;
    } else {
      delete process.env.DB_FILE;
    }
  });

  it("handles native Anthropic SSE seamlessly via OpenRouter", async () => {
    const originalAnthropicSse = `event: message_start
data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"usage":{"input_tokens":10}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"enc"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"fn","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}

event: message_stop
data: {"type":"message_stop"}

`;

    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(originalAnthropicSse));
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
      payload: {
        model: "anthropic/claude-3.5-sonnet",
        messages: [
          {
            role: "user",
            content: "hello",
          }
        ],
        stream: true
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.body;

    // Assert exactly the original Anthropic SSE with the prepended ping
    expect(body).toBe("event: ping\ndata: {\"type\":\"ping\"}\n\n" + originalAnthropicSse);

    // Verify no double message_start
    const messageStarts = body.match(/event: message_start/g) || [];
    expect(messageStarts.length).toBe(1);

    // Verify no openai chunks
    expect(body).not.toContain("chat.completion.chunk");

    // Verify data is preserved intact
    expect(body).toContain('"type":"thinking_delta"');
    expect(body).toContain('"type":"signature_delta"');
    expect(body).toContain('"type":"redacted_thinking"');
    expect(body).toContain('"type":"tool_use"');
    expect(body).toContain('"type":"input_json_delta"');
  });

  it("should NOT automatically retry on max_tokens for Native Anthropic streams", async () => {
    const originalAnthropicSse = `event: message_start
data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet-20241022","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":2}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"This is cut off"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":15}}

event: message_stop
data: {"type":"message_stop"}

`;

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchCount++;
      if (fetchCount > 1) {
        throw new Error("mock第二次 fetch若发生就直接使测试失败");
      }
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(originalAnthropicSse));
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
      payload: {
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "hello" }],
        stream: true
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.body;

    // 断言 fetchCount=1
    expect(fetchCount).toBe(1);

    // 解析最终 SSE事件
    const messageStarts = body.match(/event: message_start/g) || [];
    expect(messageStarts.length).toBe(1);

    const messageStops = body.match(/event: message_stop/g) || [];
    expect(messageStops.length).toBe(1);

    const blockStarts = body.match(/event: content_block_start/g) || [];
    const blockStops = body.match(/event: content_block_stop/g) || [];
    expect(blockStarts.length).toBe(blockStops.length);

    expect(body).toContain('"stop_reason":"max_tokens"');
  });
});
