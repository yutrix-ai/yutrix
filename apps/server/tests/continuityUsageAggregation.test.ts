import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq, like } from "drizzle-orm";
import { encryptText } from "../src/utils/crypto";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import * as actionLogger from "../src/utils/actionLogger";
import { ContinuityEngine } from "../src/services/continuity/ContinuityEngine";
import { extractCompletionMaterialForTokenEstimate } from "../src/utils/gatewayContent";
import * as tokenizer from "../src/utils/tokenizer";

vi.mock("../src/utils/tokenizer", () => {
  return {
    exactEstimateTokens: async (text: string) => text.length,
    estimateTokensFallback: (text: string) => text.length,
  };
});

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

const dbFile = "data/promptgate-test-usage-agg.sqlite";

describe("Gateway Continuity Usage Aggregation Integration Tests", () => {
  const fastify = Fastify();
  let apiKey = "";
  let userId = "";
  let savedDbFile: string | undefined;
  const loggedActions: any[] = [];
  let unsubscribe: (() => void) | undefined;

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
      username: "testuser_agg",
      passwordHash: "dummy",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rawKey = "pg_key_agg_" + crypto.randomUUID().slice(0, 8);
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
        cost: entry.params?.cost || entry.cost,
        inputTokens: entry.params?.promptTokens || entry.promptTokens || entry.params?.inputTokens || entry.inputTokens,
        outputTokens: entry.params?.completionTokens || entry.completionTokens || entry.params?.outputTokens || entry.outputTokens,
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
      await db.delete(routeAuthorizations).where(like(routeAuthorizations.routeId, "%agg-%"));
      await db.delete(endpointRoutes).where(like(endpointRoutes.id, "%agg-%"));
      await db.delete(endpoints).where(like(endpoints.id, "%agg-%"));
      await db.delete(providerModels).where(like(providerModels.providerId, "agg-%"));
      await db.delete(providerApiKeys).where(like(providerApiKeys.providerId, "agg-%"));
      await db.delete(providers).where(like(providers.id, "agg-%"));
    }
    ContinuityEngine.prototype.evaluateAll = originalEvaluateAll;
  });

  async function setupProvider(opts: {
    provId: string;
    name: string;
    openaiBaseUrl?: string | null;
    anthropicBaseUrl?: string | null;
    modelId: string;
    protocol: string;
    tokenizerRepo?: string | null;
  }) {
    await db.insert(providers).values({
      id: opts.provId,
      name: opts.name,
      openaiBaseUrl: opts.openaiBaseUrl || null,
      anthropicBaseUrl: opts.anthropicBaseUrl || null,
      concurrencyLimit: 10,
      timeoutMs: 5000,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(providerApiKeys).values({
      id: `key-${opts.provId}`,
      providerId: opts.provId,
      keyEncrypted: encryptText("dummy-key"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(providerModels).values({
      id: `model-${opts.provId}-${opts.modelId}`,
      providerId: opts.provId,
      modelId: opts.modelId,
      displayName: opts.modelId,
      rawJson: "{}",
      enabled: true,
      tokenizerRepo: opts.tokenizerRepo || null,
      createdAt: new Date(),
    });

    const routeId = `route-${opts.provId}`;
    await db.insert(endpoints).values({
      id: `ep-${opts.provId}`,
      userId,
      name: `EP-${opts.name}`,
      path: opts.protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions",
      incomingProtocol: opts.protocol,
      status: "active",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(endpointRoutes).values({
      id: routeId,
      endpointId: `ep-${opts.provId}`,
      providerId: opts.provId,
      modelId: opts.modelId,
      priority: 1,
      weight: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(routeAuthorizations).values({
      id: `auth-${opts.provId}`,
      apiKeyId: (await db.select().from(apiKeys))[0].id,
      routeId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // --- TEST CASE 1: extractCompletionMaterialForTokenEstimate ---
  describe("extractCompletionMaterialForTokenEstimate", () => {
    it("correctly extracts text, reasoning, and tool calls for OpenAI and Anthropic format", () => {
      const openaiData = {
        choices: [
          {
            message: {
              content: "hello world",
              reasoning_content: "thinking deeply",
              tool_calls: [
                {
                  id: "call_1",
                  function: { name: "get_weather", arguments: '{"location":"Seattle"}' },
                },
              ],
            },
          },
        ],
      };
      const material = extractCompletionMaterialForTokenEstimate(openaiData);
      expect(material).toContain("hello world");
      expect(material).toContain("thinking deeply");
      expect(material).toContain("get_weather");
      expect(material).toContain("Seattle");

      const anthropicData = {
        type: "message",
        content: [
          { type: "text", text: "hello anthropic" },
          { type: "thinking", thinking: "thinking step by step" },
          { type: "tool_use", id: "tu_1", name: "calculator", input: { expr: "2+2" } },
        ],
      };
      const materialAnth = extractCompletionMaterialForTokenEstimate(anthropicData);
      expect(materialAnth).toContain("hello anthropic");
      expect(materialAnth).toContain("thinking step by step");
      expect(materialAnth).toContain("calculator");
      expect(materialAnth).toContain("expr");
    });
  });

  // --- TEST CASE 2: OpenAI compatible upstream with NO usage to Anthropic client ---
  it("OpenAI compatible upstream with NO usage, translated to Anthropic client, triggers fallback", async () => {
    await setupProvider({
      provId: "agg-prov-1",
      name: "OpenAI No Usage Provider",
      openaiBaseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o-mini",
      protocol: "anthropic", // Inbound is Anthropic, outbound is OpenAI
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "chatcmpl-123",
      choices: [
        {
          message: { role: "assistant", content: "Seattle is rainy." },
          finish_reason: "stop",
        },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "How is the weather in Seattle?" }],
        max_tokens: 100,
      },
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.payload);

    expect(json.type).toBe("message");
    expect(json.content[0].text).toBe("Seattle is rainy.");
    expect(json.usage).toBeDefined();
    expect(json.usage.input_tokens).toBeGreaterThan(0);
    expect(json.usage.output_tokens).toBeGreaterThan(0);

    const completedLog = loggedActions.find((a) => a.code === "request.completed");
    expect(completedLog).toBeDefined();
    expect(completedLog.inputTokens).toBeGreaterThan(0);
    expect(completedLog.outputTokens).toBeGreaterThan(0);
  });

  // --- TEST CASE 3: finish_reason=length is a single round (no response-stage stitch) ---
  it("computes non-stream multi-round usage correctly without duplicating output text", async () => {
    await setupProvider({
      provId: "agg-prov-2",
      name: "Multi-round Provider",
      openaiBaseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o-mini",
      protocol: "openai",
    });

    // Mock tokenizer to return text.length
    vi.spyOn(tokenizer, "exactEstimateTokens").mockImplementation(async (text) => text.length);

    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "A" },
            finish_reason: "length",
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Init" }],
      },
    });

    expect(response.statusCode).toBe(200);
    console.log("RESPONSE PAYLOAD IS:", response.payload);
    const json = JSON.parse(response.payload);

    expect(json.choices[0].message.content).toBe("A");
    expect(json.choices[0].finish_reason).toBe("length");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Local estimate for output "A" => 1 token
    expect(json.usage.completion_tokens).toBe(1);

    const completedLog = loggedActions.find((a) => a.code === "request.completed");
    expect(completedLog).toBeDefined();
    expect(completedLog.outputTokens).toBe(1);
  });

  // --- TEST CASE 4: Mixed stream followed by fake-stream round isolation ---
  it("isolates round usage and avoids pollution from previous round streamedUsagePayload", async () => {
    await setupProvider({
      provId: "agg-prov-3",
      name: "Mixed Provider",
      openaiBaseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o-mini",
      protocol: "openai",
    });

    vi.spyOn(tokenizer, "exactEstimateTokens").mockImplementation(async (text) => text.length);

    let round = 0;
    const fetchMock = vi.fn().mockImplementation(async (url, config) => {
      round++;
      const isStream = config.body ? JSON.parse(config.body).stream : false;

      if (round === 1) {
        // First round: stream with real usage returned
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"A"},"finish_reason":"length"}]}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      } else {
        // Second round: non-stream JSON (fake-stream) with NO usage
        return new Response(JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "B" },
              finish_reason: "stop",
            },
          ],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    });
    vi.stubGlobal("fetch", fetchMock);

    // Force continuity after the first round using evaluateAll spy
    let calls = 0;
    vi.spyOn(ContinuityEngine.prototype, "evaluateAll").mockImplementation(async (context) => {
      calls++;
      if (calls === 1) {
        // First round evaluation: force intervention to next round
        return {
          shouldIntervene: true,
          strategyName: "MaxTokensTruncationStrategy",
          modifiedBody: {
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "Init" }, { role: "assistant", content: "A" }, { role: "user", content: "continue" }],
            stream: true,
          },
        };
      }
      return { shouldIntervene: false };
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Init" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    // Verify final totals:
    // Round 1: provider usage = 10 input, 5 output.
    // Round 2: local estimation for B (length = 1) -> 1 output.
    // We expect cumulative output = 5 + 1 = 6.
    // If polluted, it might reuse Round 1's streamedUsagePayload and result in 5 (or 5+5=10).
    console.log("DEBUG loggedActions:", JSON.stringify(loggedActions, null, 2));
    const completedLog = loggedActions.find((a) => a.code === "request.completed");
    expect(completedLog).toBeDefined();
    expect(completedLog.outputTokens).toBe(6);
  });

  // --- TEST CASE 5: Strategy budget exhaustion finalizes correctly ---
  it("finalizes correctly and logs exhausted event when strategy retries are exhausted", async () => {
    await setupProvider({
      provId: "agg-prov-4",
      name: "Exhaustion Provider",
      openaiBaseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o-mini",
      protocol: "openai",
    });

    vi.spyOn(tokenizer, "exactEstimateTokens").mockImplementation(async (text) => text.length);

    // Stub strategy evaluateAll to simulate exhaust retries immediately
    vi.spyOn(ContinuityEngine.prototype, "evaluateAll").mockResolvedValue({
      shouldIntervene: false,
      isExhausted: true,
      strategyName: "MaxTokensTruncationStrategy",
    } as any);

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: "Limit reached" },
          finish_reason: "length",
        },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Init" }],
      },
    });

    expect(response.statusCode).toBe(200);

    // Verify logAction captured "request.continuity.exhausted"
    const exhaustedLog = loggedActions.find((a) => a.code === "request.continuity.exhausted");
    expect(exhaustedLog).toBeDefined();

    // Verify there is exactly one "request.completed" log
    const completedLogs = loggedActions.filter((a) => a.code === "request.completed");
    expect(completedLogs.length).toBe(1);
  });
});
