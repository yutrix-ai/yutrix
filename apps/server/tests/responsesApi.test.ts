import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";

const dbFile = "data/promptgate_test_responses_api.sqlite";
const GEMINI_4_URL = "https://responses-gemini4-upstream.test/v1";
const GPT_6_URL = "https://responses-gpt6-upstream.test/v1";

function layer(providerId: string, modelId: string) {
  return {
    providerId,
    modelId,
    providerProtocol: "openai",
    bestEffort: false,
    strategyRoutingEnabled: false,
    strategyRoutingRules: [],
  };
}

function createSseResponse(chunks: any[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        if (chunk === "[DONE]") {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } else {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function parseSseEvents(rawBody: string): Array<{ event: string; data: any }> {
  const blocks = rawBody
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean);
  const events: Array<{ event: string; data: any }> = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) continue;
    const rawData = dataLines.join("\n");
    try {
      events.push({ event: eventName, data: JSON.parse(rawData) });
    } catch {
      events.push({ event: eventName, data: rawData });
    }
  }
  return events;
}

describe("OpenAI Responses API (/v1/responses) for Codex CLI", () => {
  const fastify = Fastify({ logger: false });
  let db: any;
  let client: any;
  let apiKey = "";
  let unauthorizedApiKey = "";

  beforeAll(async () => {
    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));
    const schema = await import("../src/db/schema");
    const { encryptText } = await import("../src/utils/crypto");

    const userId = crypto.randomUUID();
    const otherUserId = crypto.randomUUID();
    const now = new Date();

    await db.insert(schema.users).values([
      {
        id: userId,
        username: "codex-user",
        passwordHash: "dummy",
        role: "user",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: otherUserId,
        username: "unauth-user",
        passwordHash: "dummy",
        role: "user",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    apiKey = "pg_key_codex_" + crypto.randomBytes(8).toString("hex");
    unauthorizedApiKey = "pg_key_unauth_" + crypto.randomBytes(8).toString("hex");

    await db.insert(schema.apiKeys).values([
      {
        id: crypto.randomUUID(),
        userId,
        name: "Codex CLI Key",
        keyHash: crypto.createHash("sha256").update(apiKey).digest("hex"),
        keyPrefix: apiKey.substring(0, 12),
        status: "active",
        concurrencyLimit: 10,
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        userId: otherUserId,
        name: "Unauthorized Key",
        keyHash: crypto.createHash("sha256").update(unauthorizedApiKey).digest("hex"),
        keyPrefix: unauthorizedApiKey.substring(0, 12),
        status: "active",
        concurrencyLimit: 10,
        createdAt: now,
      },
    ]);

    await db
      .update(schema.systemSettings)
      .set({ value: "brtel.link", updatedAt: now })
      .where(eq(schema.systemSettings.key, "mainDomain"));

    await db.insert(schema.providers).values([
      {
        id: "prov-gemini-4",
        name: "prov-gemini-4",
        openaiBaseUrl: GEMINI_4_URL,
        anthropicBaseUrl: null,
        enabled: true,
        concurrencyLimit: 10,
        timeoutMs: 30000,
        maxOutputTokens: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "prov-gpt-6",
        name: "prov-gpt-6",
        openaiBaseUrl: GPT_6_URL,
        anthropicBaseUrl: null,
        enabled: true,
        concurrencyLimit: 10,
        timeoutMs: 30000,
        maxOutputTokens: 0,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(schema.providerModels).values([
      {
        id: crypto.randomUUID(),
        providerId: "prov-gemini-4",
        modelId: "gemini-4-argon-high",
        displayName: "gemini-4-argon-high",
        enabled: true,
        active: true,
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        providerId: "prov-gpt-6",
        modelId: "gemini-3.8-flash-high",
        displayName: "gemini-3.8-flash-high",
        enabled: true,
        active: true,
        createdAt: now,
      },
    ]);

    await db.insert(schema.providerApiKeys).values([
      {
        id: "prov-gemini-4-key",
        providerId: "prov-gemini-4",
        keyEncrypted: encryptText("sk-upstream-gemini4"),
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "prov-gpt-6-key",
        providerId: "prov-gpt-6",
        keyEncrypted: encryptText("sk-upstream-gpt6"),
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(schema.subdomains).values({
      id: "code-sub",
      userId,
      name: "code",
      hostname: "code.brtel.link",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });

    // Only /v1/chat/completions is configured in DB (just like production code.brtel.link)
    await db.insert(schema.endpoints).values({
      id: "ep-chat-completions",
      userId,
      name: "OpenAI Chat Completions",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const gemini4Profile = {
      name: "gemini-4",
      routingMode: "classic",
      targets: [layer("prov-gemini-4", "gemini-4-argon-high")],
    };

    const defaultTargets = [layer("prov-gpt-6", "gemini-3.8-flash-high")];

    await db.insert(schema.endpointRoutes).values({
      id: "route-code-brtel",
      name: "code.brtel.link route",
      endpointId: "ep-chat-completions",
      subdomainId: "code-sub",
      hosts: JSON.stringify(["code.brtel.link"]),
      providerId: "prov-gpt-6",
      providerProtocol: "openai",
      modelId: "gemini-3.8-flash-high",
      retryCount: 0,
      routingMode: "classic",
      targets: JSON.stringify(defaultTargets),
      modelProfiles: JSON.stringify([gemini4Profile]),
      enabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId: "route-code-brtel",
      userId,
      createdAt: now,
    });

    const gatewayRoutes = (await import("../src/routes/gateway")).default;
    await fastify.register(gatewayRoutes);
    await fastify.ready();
  }, 30000);

  afterAll(async () => {
    await fastify.close();
    await closeAndCleanup(client, dbFile);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Step 1: Non-streaming POST /v1/responses routes gemini-4 -> gemini-4-argon-high and gpt-6 -> gemini-3.8-flash-high and returns Responses object", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any, init: any) => {
        const url = String(input);
        const reqBody = JSON.parse(String(init?.body || "{}"));
        calls.push({ url, body: reqBody });

        return new Response(
          JSON.stringify({
            id: "chatcmpl-step1",
            object: "chat.completion",
            created: 1761380000,
            model: reqBody.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "pong" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    for (const [alias, expectedUpstreamUrl, expectedUpstreamModel] of [
      ["gemini-4", `${GEMINI_4_URL}/chat/completions`, "gemini-4-argon-high"],
      ["gpt-6", `${GPT_6_URL}/chat/completions`, "gemini-3.8-flash-high"],
    ] as const) {
      calls.length = 0;
      const res = await fastify.inject({
        method: "POST",
        url: "/v1/responses",
        headers: {
          host: "code.brtel.link",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        payload: {
          model: alias,
          input: "Reply with the single word pong.",
          max_output_tokens: 16,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(expectedUpstreamUrl);
      expect(calls[0].body.model).toBe(expectedUpstreamModel);
      expect(calls[0].body.messages).toEqual([
        { role: "user", content: "Reply with the single word pong." },
      ]);
      expect(calls[0].body.max_tokens).toBe(16);
      // Responses-only fields must NOT leak to Chat Completions upstream
      expect(calls[0].body.input).toBeUndefined();
      expect(calls[0].body.max_output_tokens).toBeUndefined();

      const body = res.json();
      expect(body.object).toBe("response");
      expect(body.status).toBe("completed");
      expect(body.model).toBe(expectedUpstreamModel);
      expect(body.output_text).toBe("pong");
      expect(Array.isArray(body.output)).toBe(true);
      expect(body.output).toHaveLength(1);
      expect(body.output[0]).toMatchObject({
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "pong",
            annotations: [],
          },
        ],
      });
      expect(body.usage).toMatchObject({
        input_tokens: 12,
        output_tokens: 1,
        total_tokens: 13,
      });
    }
  });

  it("Step 2: Streaming POST /v1/responses (stream: true) emits Responses SSE lifecycle ending with response.completed for both gemini-4 and gpt-6", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: any, init: any) => {
        const reqBody = JSON.parse(String(init?.body || "{}"));
        return createSseResponse([
          {
            id: "chatcmpl-stream-1",
            object: "chat.completion.chunk",
            created: 1761380000,
            model: reqBody.model,
            choices: [{ index: 0, delta: { role: "assistant", content: "po" }, finish_reason: null }],
          },
          {
            id: "chatcmpl-stream-1",
            object: "chat.completion.chunk",
            created: 1761380000,
            model: reqBody.model,
            choices: [{ index: 0, delta: { content: "ng" }, finish_reason: null }],
          },
          {
            id: "chatcmpl-stream-1",
            object: "chat.completion.chunk",
            created: 1761380000,
            model: reqBody.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          },
          "[DONE]",
        ]);
      }),
    );

    for (const [alias, expectedUpstreamModel] of [
      ["gemini-4", "gemini-4-argon-high"],
      ["gpt-6", "gemini-3.8-flash-high"],
    ] as const) {
      const res = await fastify.inject({
        method: "POST",
        url: "/v1/responses",
        headers: {
          host: "code.brtel.link",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        payload: {
          model: alias,
          input: "Reply with the single word pong.",
          max_output_tokens: 16,
          stream: true,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      // Must NOT contain Chat Completions [DONE] sentinel or chat.completion.chunk
      expect(res.body).not.toContain("data: [DONE]");
      expect(res.body).not.toContain("chat.completion.chunk");

      const events = parseSseEvents(res.body);
      const eventTypes = events.map((e) => e.event);

      expect(eventTypes).toEqual([
        "response.created",
        "response.in_progress",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_text.delta",
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.completed",
      ]);

      const deltas = events
        .filter((e) => e.event === "response.output_text.delta")
        .map((e) => e.data.delta)
        .join("");
      expect(deltas).toBe("pong");

      const completedEvt = events[events.length - 1];
      expect(completedEvt.event).toBe("response.completed");
      expect(completedEvt.data.response.status).toBe("completed");
      expect(completedEvt.data.response.model).toBe(expectedUpstreamModel);
      expect(completedEvt.data.response.output_text).toBe("pong");
      expect(completedEvt.data.response.output[0].content[0].text).toBe("pong");
      expect(completedEvt.data.response.usage).toMatchObject({
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
      });
    }
  });

  it("Step 3: Multi-turn stateless continuation replays prior input and assistant output items", async () => {
    let capturedBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: any, init: any) => {
        capturedBody = JSON.parse(String(init?.body || "{}"));
        return new Response(
          JSON.stringify({
            id: "chatcmpl-turn2",
            object: "chat.completion",
            created: 1761380001,
            model: capturedBody.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Your secret number is 42." },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 25, completion_tokens: 7, total_tokens: 32 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        host: "code.brtel.link",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gemini-4",
        instructions: "You are a helpful coding assistant.",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Remember the secret number 42." }],
          },
          {
            id: "msg_prev_1",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "Understood, I will remember 42.", annotations: [] }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "What was the secret number?" }],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(capturedBody.messages).toEqual([
      { role: "system", content: "You are a helpful coding assistant." },
      { role: "user", content: "Remember the secret number 42." },
      { role: "assistant", content: "Understood, I will remember 42." },
      { role: "user", content: "What was the secret number?" },
    ]);

    const body = res.json();
    expect(body.object).toBe("response");
    expect(body.output_text).toBe("Your secret number is 42.");
  });

  it("Step 4: Function tool call loop works end-to-end (both streaming and non-streaming) with matching call_id", async () => {
    const capturedBodies: any[] = [];
    let turn = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: any, init: any) => {
        turn++;
        const reqBody = JSON.parse(String(init?.body || "{}"));
        capturedBodies.push(reqBody);

        if (turn === 1) {
          // Turn 1 (Streaming): Model emits a function tool call
          return createSseResponse([
            {
              id: "chatcmpl-tool-1",
              object: "chat.completion.chunk",
              created: 1761380010,
              model: reqBody.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_exec_123",
                        type: "function",
                        function: { name: "exec_command", arguments: '{"cmd":' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "chatcmpl-tool-1",
              object: "chat.completion.chunk",
              created: 1761380010,
              model: reqBody.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: { arguments: '"pwd"}' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "chatcmpl-tool-1",
              object: "chat.completion.chunk",
              created: 1761380010,
              model: reqBody.model,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
            },
            "[DONE]",
          ]);
        }

        // Turn 2 (Non-streaming): Client submits function_call_output, model answers
        return new Response(
          JSON.stringify({
            id: "chatcmpl-tool-2",
            object: "chat.completion",
            created: 1761380011,
            model: reqBody.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "The current working directory is /workspace/yutrix.",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 9, total_tokens: 59 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const tools = [
      {
        type: "function",
        name: "exec_command",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
        strict: false,
      },
    ];

    // Turn 1: Streaming request with function tool
    const turn1Res = await fastify.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        host: "code.brtel.link",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-6",
        input: [{ type: "message", role: "user", content: "Check current directory." }],
        tools,
        tool_choice: "auto",
        stream: true,
      },
    });

    expect(turn1Res.statusCode).toBe(200);
    expect(capturedBodies[0].tools).toEqual([
      {
        type: "function",
        function: {
          name: "exec_command",
          description: "Run a shell command",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
          },
          strict: false,
        },
      },
    ]);

    const turn1Events = parseSseEvents(turn1Res.body);
    const turn1EventTypes = turn1Events.map((e) => e.event);
    expect(turn1EventTypes).toContain("response.output_item.added");
    expect(turn1EventTypes).toContain("response.function_call_arguments.delta");
    expect(turn1EventTypes).toContain("response.function_call_arguments.done");
    expect(turn1EventTypes).toContain("response.output_item.done");
    expect(turn1EventTypes[turn1EventTypes.length - 1]).toBe("response.completed");

    const completedTurn1 = turn1Events[turn1Events.length - 1].data.response;
    expect(completedTurn1.output).toHaveLength(1);
    const fnCallItem = completedTurn1.output[0];
    expect(fnCallItem).toMatchObject({
      type: "function_call",
      status: "completed",
      call_id: "call_exec_123",
      name: "exec_command",
      arguments: '{"cmd":"pwd"}',
    });

    // Turn 2: Client executes tool and replays input + function_call + function_call_output
    const turn2Res = await fastify.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        host: "code.brtel.link",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-6",
        input: [
          { type: "message", role: "user", content: "Check current directory." },
          fnCallItem,
          {
            type: "function_call_output",
            call_id: fnCallItem.call_id,
            output: "/workspace/yutrix\n",
          },
        ],
        tools,
        stream: false,
      },
    });

    expect(turn2Res.statusCode).toBe(200);
    expect(capturedBodies[1].messages).toEqual([
      { role: "user", content: "Check current directory." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_exec_123",
            type: "function",
            function: {
              name: "exec_command",
              arguments: '{"cmd":"pwd"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_exec_123",
        content: "/workspace/yutrix\n",
      },
    ]);

    const turn2Body = turn2Res.json();
    expect(turn2Body.object).toBe("response");
    expect(turn2Body.status).toBe("completed");
    expect(turn2Body.output_text).toBe(
      "The current working directory is /workspace/yutrix.",
    );
  });

  it("Step 5: Custom tool call (type: 'custom', e.g. Codex apply_patch) and reasoning items round-trip cleanly", async () => {
    let capturedBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: any, init: any) => {
        capturedBody = JSON.parse(String(init?.body || "{}"));
        return new Response(
          JSON.stringify({
            id: "chatcmpl-custom-1",
            object: "chat.completion",
            created: 1761380020,
            model: capturedBody.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  reasoning_content: "Let me patch the file.",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_patch_1",
                      type: "function",
                      function: {
                        name: "apply_patch",
                        arguments: JSON.stringify({
                          input: "*** Begin Patch\n*** Update File: a.txt\n*** End Patch",
                        }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        host: "code.brtel.link",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gemini-4",
        input: "Patch a.txt",
        tools: [
          {
            type: "custom",
            name: "apply_patch",
            description: "Patch a file",
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.output).toHaveLength(2);
    expect(body.output[0]).toMatchObject({
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: "Let me patch the file." }],
    });
    expect(body.output[1]).toMatchObject({
      type: "custom_tool_call",
      status: "completed",
      call_id: "call_patch_1",
      name: "apply_patch",
      input: "*** Begin Patch\n*** Update File: a.txt\n*** End Patch",
    });
  });

  it("Step 6: Error differentiation (401 invalid token, 403 unauthorized route, 400 missing input, 404 unknown model, 429 rate limit, 502 upstream error) in both non-stream and stream modes", async () => {
    // 1. 401 Invalid Bearer Token
    const res401 = await fastify.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        host: "code.brtel.link",
        authorization: "Bearer invalid_token_xyz",
        "content-type": "application/json",
      },
      payload: {
        model: "gemini-4",
        input: "ping",
      },
    });
    expect(res401.statusCode).toBe(401);
    expect(res401.json().error.code).toBe("invalid_api_key");

    // 2. 403 Unauthorized User for Route
    const res403 = await fastify.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        host: "code.brtel.link",
        authorization: `Bearer ${unauthorizedApiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gemini-4",
        input: "ping",
      },
    });
    expect(res403.statusCode).toBe(403);

    // 3. 400 Missing input parameter
    const res400 = await fastify.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        host: "code.brtel.link",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gemini-4",
      },
    });
    expect(res400.statusCode).toBe(400);
    expect(res400.json().error.code).toBe("missing_required_parameter");

    // 4. 404 Unknown model from upstream (even when stream: true!)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: "The model `unknown-model` does not exist",
              type: "invalid_request_error",
              code: "model_not_found",
            },
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const res404Stream = await fastify.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        host: "code.brtel.link",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gemini-4",
        input: "ping",
        stream: true,
      },
    });
    expect(res404Stream.statusCode).toBe(404);
    expect(res404Stream.json().error.message).toContain("does not exist");

    // 5. 429 Rate Limit from upstream (when stream: true)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: "Rate limit reached",
              type: "rate_limit_error",
              code: "rate_limit_exceeded",
            },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const res429Stream = await fastify.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        host: "code.brtel.link",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-6",
        input: "ping",
        stream: true,
      },
    });
    expect(res429Stream.statusCode).toBe(429);
    expect(res429Stream.json().error.message).toContain("Rate limit");

    // 6. 502 Upstream network error
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED upstream down");
      }),
    );

    const res502 = await fastify.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        host: "code.brtel.link",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gemini-4",
        input: "ping",
        stream: true,
      },
    });
    expect(res502.statusCode).toBe(502);
  });
});
