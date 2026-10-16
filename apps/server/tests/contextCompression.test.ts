import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { migrate } from "drizzle-orm/libsql/migrator";
import {
  applyContextSummary,
  buildCompressorTranscript,
  planContextCompression,
  reachesCompressFill,
  readLayerOverflowAction,
  SUMMARY_MARKER,
} from "../src/routes/gateway/contextCompression";

describe("context compression plan", () => {
  const history = {
    messages: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "fix the login bug" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "read_file" } }],
      },
      { role: "tool", content: "Error: ENOENT src/login.ts" },
      { role: "user", content: "it is src/auth/login.ts, not src/login.ts" },
      { role: "assistant", content: "Updated the path." },
      { role: "user", content: "now add a test" },
      { role: "assistant", content: "Adding the test." },
    ],
  };

  it("summarizes older turns and keeps the last two turns intact, including tool pairs", () => {
    const plan = planContextCompression(history);
    expect(plan).not.toBeNull();
    expect(plan!.systemMessages.map((message) => message.role)).toEqual(["system"]);
    expect(plan!.olderTurns).toBe(1);
    expect(plan!.older.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(plan!.kept.map((message) => message.content)).toEqual([
      "it is src/auth/login.ts, not src/login.ts",
      "Updated the path.",
      "now add a test",
      "Adding the test.",
    ]);
  });

  it("does not summarize when the whole conversation is the recent tail", () => {
    expect(planContextCompression({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    })).toBeNull();
  });

  it("notes images in the transcript and puts the summary in front of the kept turns", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "see this" }, { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] },
        { role: "assistant", content: "noted" },
        { role: "user", content: "continue" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "latest" },
        { role: "assistant", content: "done" },
      ],
    };
    const plan = planContextCompression(body)!;
    const transcript = buildCompressorTranscript(plan.older);
    expect(transcript).toContain("[image omitted]");
    expect(transcript).not.toContain("base64,abc");
    expect(transcript).toContain("## Goal");
    expect(transcript).toContain("Quote corrections verbatim");

    const next = applyContextSummary(body, "Login bug is in src/auth/login.ts.", plan);
    expect(next.messages[0].content).toContain(SUMMARY_MARKER);
    expect(next.messages[0].content).toContain("src/auth/login.ts");
    expect(next.messages[next.messages.length - 1].content).toBe("done");
    expect(JSON.stringify(next.messages)).not.toContain("base64,abc");
    expect(body.messages[0].content[1].image_url.url).toContain("base64,abc");
  });

  it("triggers at 80% of the configured window and defaults the layer switch to long context", () => {
    expect(reachesCompressFill(8000, 10000)).toBe(true);
    expect(reachesCompressFill(7999, 10000)).toBe(false);
    expect(reachesCompressFill(5000, 0)).toBe(false);
    expect(readLayerOverflowAction({ targets: [{ overflowAction: "compress" }] }, 0)).toBe("compress");
    expect(readLayerOverflowAction({ targets: [{}] }, 0)).toBe("long_context");
    expect(readLayerOverflowAction({ targets: "[]" }, 0)).toBe("long_context");
  });
});

const testDbPath = "data/promptgate_test_context_compress.sqlite";
process.env.DB_FILE = testDbPath;

describe("context compression gateway", () => {
  let db: any;
  let schema: any;
  let apiKey: string;
  const fastify = Fastify();
  const provId = "compress-prov";

  const resolvedDbPath = () =>
    process.cwd().endsWith("server") ? path.join(process.cwd(), "../../", testDbPath) : path.join(process.cwd(), testDbPath);

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(resolvedDbPath() + suffix); } catch {}
    }
    const dbModule = await import("../src/db");
    await dbModule.initDb();
    db = dbModule.db;
    schema = await import("../src/db/schema");
    const { bootstrap } = await import("../src/bootstrap");
    const gatewayRoutes = (await import("../src/routes/gateway")).default;
    const { encryptText } = await import("../src/utils/crypto");

    await migrate(db, {
      migrationsFolder: path.resolve(process.cwd(), process.cwd().endsWith("server") ? "./drizzle" : "apps/server/drizzle"),
    });
    await bootstrap();
    fastify.register(gatewayRoutes);
    await fastify.ready();

    const userId = crypto.randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      username: `compress_${crypto.randomUUID()}`,
      passwordHash: "dummy",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    apiKey = "pg_key_compress_" + crypto.randomUUID();
    await db.insert(schema.apiKeys).values({
      id: crypto.randomUUID(),
      userId,
      name: "compress key",
      keyHash: crypto.createHash("sha256").update(apiKey).digest("hex"),
      keyPrefix: "pg_key_compress",
      concurrencyLimit: 5,
      status: "active",
      createdAt: new Date(),
    });
    await db.insert(schema.providers).values({
      id: provId,
      name: "Compress Provider",
      openaiBaseUrl: "https://compress.example.com/v1",
      enabled: true,
      concurrencyLimit: 10,
      timeoutMs: 60000,
      streamTimeoutMs: 180000,
      hourlyTokenLimit: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.providerApiKeys).values({
      id: "compress-key-1",
      providerId: provId,
      keyEncrypted: encryptText("sk-compress-dummy"),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    for (const modelId of ["vis-1", "lc-a"]) {
      await db.insert(schema.providerModels).values({
        id: crypto.randomUUID(),
        providerId: provId,
        modelId,
        displayName: modelId,
        enabled: true,
        active: true,
        rawJson: modelId === "vis-1" ? JSON.stringify({ contextWindowTokens: 10000 }) : null,
        createdAt: new Date(),
      });
    }
    await db.insert(schema.endpoints).values({
      id: "compress-ep",
      userId,
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const routeId = "compress-route";
    await db.insert(schema.endpointRoutes).values({
      id: routeId,
      name: "Compress Route",
      endpointId: "compress-ep",
      priority: 1,
      providerId: provId,
      providerProtocol: "openai",
      modelId: "vis-1",
      targetType: "multi",
      fallbackEnabled: 3,
      targets: JSON.stringify([{
        providerId: provId,
        providerProtocol: "openai",
        modelId: "vis-1",
        weight: 100,
        retryCount: 0,
        overflowAction: "compress",
        strategyRoutingEnabled: true,
        strategyRoutingRules: JSON.stringify([
          { providerId: provId, providerProtocol: "openai", modelId: "vis-1", taskType: "vision", enabled: true },
          { providerId: provId, providerProtocol: "openai", modelId: "lc-a", taskType: "long_context", enabled: true },
          { providerId: provId, providerProtocol: "openai", modelId: "vis-1", taskType: "general", enabled: true },
        ]),
      }]),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.routeAuthorizations).values({
      id: crypto.randomUUID(),
      routeId,
      userId,
      createdAt: new Date(),
    });
  });

  afterAll(async () => {
    await fastify.close();
    vi.unstubAllGlobals();
  });

  it("at 80% of the window, summarizes older turns with the long-context model and sends the image to the original model", async () => {
    const requests: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const reqBody = JSON.parse(String(init?.body || "{}"));
      requests.push(reqBody);
      if (reqBody.model === "lc-a") {
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "## Goal\nFix the login bug in src/auth/login.ts." } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "chatcmpl-c",
        object: "chat.completion",
        created: Date.now(),
        model: reqBody.model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: {
        model: "vis-1",
        stream: false,
        messages: [
          ...Array.from({ length: 8 }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `turn ${i} ` + "x".repeat(2000),
          })),
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image_url", image_url: { url: "data:image/png;base64,mock" } },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(requests.map((req) => req.model)).toEqual(["lc-a", "vis-1"]);
    const forwarded = requests[1];
    expect(JSON.stringify(forwarded.messages[0])).toContain(SUMMARY_MARKER);
    expect(JSON.stringify(forwarded.messages[0])).toContain("src/auth/login.ts");
    expect(JSON.stringify(forwarded.messages)).toContain("image_url");
    expect(forwarded.messages.length).toBeLessThan(9);
    expect(requests[0].messages[0].content).not.toContain("base64,mock");
  });
});
