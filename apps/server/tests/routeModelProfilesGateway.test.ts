import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";

const dbFile = "data/promptgate_test_route_model_profiles_gateway.sqlite";
const DEF_L0 = "https://rmp-def-l0.test/v1";
const DEF_L1 = "https://rmp-def-l1.test/v1";
const PROF_L0 = "https://rmp-prof-l0.test/v1";
const PROF_L1 = "https://rmp-prof-l1.test/v1";
const SCHED = "https://rmp-sched.test/v1";

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

const defaultTargets = [layer("rmp-p-def-l0", "def-a"), layer("rmp-p-def-l1", "def-b")];
const cheapProfile = {
  name: "Yutrix-Cheap",
  routingMode: "classic",
  targets: [layer("rmp-p-prof-l0", "cheap-a"), layer("rmp-p-prof-l1", "cheap-b")],
};

describe("route model profiles on the gateway", () => {
  const fastify = Fastify({ logger: false });
  let db: any;
  let client: any;
  let endpointRoutes: any;
  let apiKey = "";

  beforeAll(async () => {
    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));
    const schema = await import("../src/db/schema");
    endpointRoutes = schema.endpointRoutes;
    const { encryptText } = await import("../src/utils/crypto");

    const userId = crypto.randomUUID();
    const now = new Date();
    await db.insert(schema.users).values({
      id: userId,
      username: "rmp-user",
      passwordHash: "dummy",
      role: "user",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    apiKey = "pg_key_rmp_" + crypto.randomBytes(8).toString("hex");
    await db.insert(schema.apiKeys).values({
      id: crypto.randomUUID(),
      userId,
      name: "rmp key",
      keyHash: crypto.createHash("sha256").update(apiKey).digest("hex"),
      keyPrefix: apiKey.substring(0, 12),
      status: "active",
      concurrencyLimit: 10,
      createdAt: now,
    });

    await db.delete(schema.systemSettings).where(eq(schema.systemSettings.key, "allowUnknownHostFallback"));
    await db.insert(schema.systemSettings).values({
      key: "allowUnknownHostFallback",
      value: "true",
      description: "route model profile tests",
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(schema.systemSettings)
      .set({ value: "example.com", updatedAt: now })
      .where(eq(schema.systemSettings.key, "mainDomain"));

    const providerRows = [
      { id: "rmp-p-def-l0", url: DEF_L0, model: "def-a" },
      { id: "rmp-p-def-l1", url: DEF_L1, model: "def-b" },
      { id: "rmp-p-prof-l0", url: PROF_L0, model: "cheap-a" },
      { id: "rmp-p-prof-l1", url: PROF_L1, model: "cheap-b" },
      { id: "rmp-p-sched", url: SCHED, model: "sched-a" },
    ];
    await db.insert(schema.providers).values(
      providerRows.map((p) => ({
        id: p.id,
        name: p.id,
        openaiBaseUrl: p.url,
        anthropicBaseUrl: null,
        enabled: true,
        concurrencyLimit: 10,
        timeoutMs: 30000,
        maxOutputTokens: 0,
        createdAt: now,
        updatedAt: now,
      })),
    );
    await db.insert(schema.providerModels).values(
      providerRows.map((p) => ({
        id: crypto.randomUUID(),
        providerId: p.id,
        modelId: p.model,
        displayName: p.model,
        enabled: true,
        active: true,
        createdAt: now,
      })),
    );
    // Same-name model on the profile's L1, for best-effort (尽力而为) degradation.
    await db.insert(schema.providerModels).values({
      id: crypto.randomUUID(),
      providerId: "rmp-p-prof-l1",
      modelId: "cheap-a",
      displayName: "cheap-a",
      enabled: true,
      active: true,
      createdAt: now,
    });
    await db.insert(schema.providerApiKeys).values(
      providerRows.map((p) => ({
        id: `${p.id}-key`,
        providerId: p.id,
        keyEncrypted: encryptText("sk-rmp"),
        status: "active",
        createdAt: now,
        updatedAt: now,
      })),
    );

    const subs = ["rmp-main", "rmp-legacy", "rmp-sched", "rmp-corrupt", "rmp-be"];
    await db.insert(schema.subdomains).values(
      subs.map((name) => ({
        id: `${name}-sub`,
        userId,
        name,
        hostname: `${name}.example.com`,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })),
    );

    const endpointId = "rmp-endpoint";
    await db.insert(schema.endpoints).values({
      id: endpointId,
      userId,
      name: "rmp endpoint",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const alwaysOnSchedule = {
      id: "rmp-schedule",
      name: "always",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: "00:00",
      endTime: "00:00",
      endNextDay: true,
      useDailyStartAsEnd: true,
      providerId: "rmp-p-sched",
      providerProtocol: "openai",
      modelId: "sched-a",
      allowClientModel: false,
      fallbackEnabled: false,
      fallbackMatchTarget: false,
    };

    const baseRoute = {
      endpointId,
      providerId: "rmp-p-def-l0",
      providerProtocol: "openai",
      modelId: "def-a",
      retryCount: 3,
      routingMode: "classic",
      targets: JSON.stringify(defaultTargets),
      enabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(endpointRoutes).values([
      { ...baseRoute, id: "rmp-route-main", name: "main", subdomainId: "rmp-main-sub", modelProfiles: JSON.stringify([cheapProfile]) },
      { ...baseRoute, id: "rmp-route-legacy", name: "legacy", subdomainId: "rmp-legacy-sub" },
      {
        ...baseRoute,
        id: "rmp-route-sched",
        name: "sched",
        subdomainId: "rmp-sched-sub",
        modelProfiles: JSON.stringify([cheapProfile]),
        schedules: JSON.stringify([alwaysOnSchedule]),
      },
      { ...baseRoute, id: "rmp-route-corrupt", name: "corrupt", subdomainId: "rmp-corrupt-sub", modelProfiles: "{not json" },
      {
        ...baseRoute,
        id: "rmp-route-be",
        name: "best effort",
        subdomainId: "rmp-be-sub",
        fallbackMatchTarget: true,
        modelProfiles: JSON.stringify([cheapProfile]),
      },
    ]);
    await db.insert(schema.routeAuthorizations).values(
      ["rmp-route-main", "rmp-route-legacy", "rmp-route-sched", "rmp-route-corrupt", "rmp-route-be"].map((routeId) => ({
        id: crypto.randomUUID(),
        routeId,
        userId,
        createdAt: now,
      })),
    );

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

  function okResponse(model: string) {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-rmp",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: `from ${model}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  function modelNotFound() {
    return new Response(
      JSON.stringify({ message: "model unavailable", type: "invalid_request_error", code: "model_not_found" }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }

  type Call = { url: string; model: string };

  function stubUpstream(failing: string[] = []) {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      calls.push({ url: String(url), model: body.model });
      if (failing.some((base) => String(url).startsWith(base))) return modelNotFound();
      return okResponse(body.model);
    });
    return calls;
  }

  async function chat(host: string, model: string) {
    return fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${apiKey}`, host },
      payload: { model, messages: [{ role: "user", content: "hello" }] },
    });
  }

  it("a route without profiles behaves exactly as before", async () => {
    const calls = stubUpstream();
    const res = await chat("rmp-legacy.example.com", "Yutrix-Cheap");
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ url: `${DEF_L0}/chat/completions`, model: "def-a" }]);
  });

  it("an unmatched model id uses the default table", async () => {
    const calls = stubUpstream();
    const res = await chat("rmp-main.example.com", "gpt-4o");
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ url: `${DEF_L0}/chat/completions`, model: "def-a" }]);
  });

  it("a matching model id (trimmed, case-insensitive) uses the profile table", async () => {
    const calls = stubUpstream();
    const res = await chat("rmp-main.example.com", "  yutrix-CHEAP ");
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe("from cheap-a");
    expect(calls).toEqual([{ url: `${PROF_L0}/chat/completions`, model: "cheap-a" }]);
  });

  it("degrades inside the profile table and never touches default layers", async () => {
    const calls = stubUpstream([PROF_L0]);
    const res = await chat("rmp-main.example.com", "Yutrix-Cheap");
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe("from cheap-b");
    expect(calls.filter((c) => c.url.startsWith(PROF_L0))).toHaveLength(1);
    expect(calls.filter((c) => c.url.startsWith(PROF_L1))).toEqual([
      { url: `${PROF_L1}/chat/completions`, model: "cheap-b" },
    ]);
    expect(calls.some((c) => c.url.startsWith(DEF_L0) || c.url.startsWith(DEF_L1))).toBe(false);
  });

  it("default table degradation is unchanged on a route that has profiles", async () => {
    const calls = stubUpstream([DEF_L0]);
    const res = await chat("rmp-main.example.com", "something-else");
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe("from def-b");
    expect(calls.some((c) => c.url.startsWith(PROF_L0) || c.url.startsWith(PROF_L1))).toBe(false);
  });

  it("route-level best effort applies while degrading inside a profile table", async () => {
    const calls = stubUpstream([PROF_L0]);
    const res = await chat("rmp-be.example.com", "Yutrix-Cheap");
    expect(res.statusCode).toBe(200);
    expect(calls.filter((c) => c.url.startsWith(PROF_L1))).toEqual([
      { url: `${PROF_L1}/chat/completions`, model: "cheap-a" },
    ]);
  });

  it("schedules still apply to the default table but not to a matched profile", async () => {
    let calls = stubUpstream();
    let res = await chat("rmp-sched.example.com", "gpt-4o");
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ url: `${SCHED}/chat/completions`, model: "sched-a" }]);

    vi.unstubAllGlobals();
    calls = stubUpstream();
    res = await chat("rmp-sched.example.com", "Yutrix-Cheap");
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ url: `${PROF_L0}/chat/completions`, model: "cheap-a" }]);
  });

  it("a corrupt modelProfiles column falls back to the default table", async () => {
    const calls = stubUpstream();
    const res = await chat("rmp-corrupt.example.com", "Yutrix-Cheap");
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ url: `${DEF_L0}/chat/completions`, model: "def-a" }]);
  });

  it("lists profile names in /v1/models for the matching host only", async () => {
    const main = await fastify.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${apiKey}`, host: "rmp-main.example.com" },
    });
    expect(main.statusCode).toBe(200);
    expect(main.json().data.map((m: any) => m.id)).toContain("Yutrix-Cheap");

    const legacy = await fastify.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${apiKey}`, host: "rmp-legacy.example.com" },
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().data.map((m: any) => m.id)).not.toContain("Yutrix-Cheap");
  });
});
