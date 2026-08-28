import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import { globalTimeoutEjectStore } from "../src/routes/gateway/timeoutEject";

const dbFile = "data/promptgate_test_timeout_eject.sqlite";
const TIMEOUT_MS = 300;
const L0_ON = "https://teject-l0-on.test/v1";
const L1_ON = "https://teject-l1-on.test/v1";
const L0_OFF = "https://teject-l0-off.test/v1";
const L1_OFF = "https://teject-l1-off.test/v1";
const L0_ISO = "https://teject-l0-iso.test/v1";
const L1_ISO = "https://teject-l1-iso.test/v1";
const L0_REC = "https://teject-l0-rec.test/v1";
const L1_REC = "https://teject-l1-rec.test/v1";

describe("timeout eject gateway + admin", () => {
  const fastify = Fastify({ logger: false });
  let db: any;
  let client: any;
  let apiKeys: any;
  let endpoints: any;
  let endpointRoutes: any;
  let providerApiKeys: any;
  let providerModels: any;
  let providers: any;
  let routeAuthorizations: any;
  let subdomains: any;
  let systemSettings: any;
  let users: any;
  let encryptText: any;
  let apiKey = "";
  let userId = "";
  let adminId = "admin-timeout-eject";
  const routeOnId = "teject-route-on";
  const routeOffId = "teject-route-off";
  const routeIsoId = "teject-route-iso";
  const routeRecId = "teject-route-rec";

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
      subdomains,
      systemSettings,
      users,
    } = await import("../src/db/schema"));
    ({ encryptText } = await import("../src/utils/crypto"));

    userId = crypto.randomUUID();
    const now = new Date();
    await db.insert(users).values([
      {
        id: userId,
        username: "teject-user",
        passwordHash: "dummy",
        role: "user",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: adminId,
        username: "teject-admin",
        passwordHash: "dummy",
        role: "admin",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const rawKey = "pg_key_teject_" + crypto.randomBytes(8).toString("hex");
    apiKey = rawKey;
    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      userId,
      name: "teject key",
      keyHash: crypto.createHash("sha256").update(rawKey).digest("hex"),
      keyPrefix: rawKey.substring(0, 12),
      status: "active",
      concurrencyLimit: 10,
      createdAt: now,
    });

    await db.delete(systemSettings).where(eq(systemSettings.key, "allowUnknownHostFallback"));
    await db.insert(systemSettings).values({
      key: "allowUnknownHostFallback",
      value: "true",
      description: "timeout eject tests",
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(systemSettings)
      .set({ value: "example.com", updatedAt: now })
      .where(eq(systemSettings.key, "mainDomain"));

    const providerRows = [
      { id: "teject-p-on-l0", name: "On L0", url: L0_ON },
      { id: "teject-p-on-l1", name: "On L1", url: L1_ON },
      { id: "teject-p-off-l0", name: "Off L0", url: L0_OFF },
      { id: "teject-p-off-l1", name: "Off L1", url: L1_OFF },
      { id: "teject-p-iso-l0", name: "Iso L0", url: L0_ISO },
      { id: "teject-p-iso-l1", name: "Iso L1", url: L1_ISO },
      { id: "teject-p-rec-l0", name: "Rec L0", url: L0_REC },
      { id: "teject-p-rec-l1", name: "Rec L1", url: L1_REC },
    ];
    await db.insert(providers).values(
      providerRows.map((p) => ({
        id: p.id,
        name: p.name,
        openaiBaseUrl: p.url,
        anthropicBaseUrl: null,
        enabled: true,
        concurrencyLimit: 10,
        timeoutMs: TIMEOUT_MS,
        maxOutputTokens: 0,
        createdAt: now,
        updatedAt: now,
      })),
    );
    await db.insert(providerModels).values(
      providerRows.map((p) => ({
        id: crypto.randomUUID(),
        providerId: p.id,
        modelId: `${p.id}-model`,
        displayName: p.name,
        enabled: true,
        active: true,
        createdAt: now,
      })),
    );
    await db.insert(providerApiKeys).values(
      providerRows.map((p) => ({
        id: `${p.id}-key`,
        providerId: p.id,
        keyEncrypted: encryptText("sk-teject"),
        status: "active",
        createdAt: now,
        updatedAt: now,
      })),
    );

    const hostRows = [
      { id: "teject-sub-on", hostname: "teject-on.example.com" },
      { id: "teject-sub-off", hostname: "teject-off.example.com" },
      { id: "teject-sub-iso", hostname: "teject-iso.example.com" },
      { id: "teject-sub-rec", hostname: "teject-rec.example.com" },
    ];
    await db.insert(subdomains).values(
      hostRows.map((h) => ({
        id: h.id,
        userId,
        name: h.hostname.split(".")[0],
        hostname: h.hostname,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })),
    );

    const endpointId = "teject-endpoint";
    await db.insert(endpoints).values({
      id: endpointId,
      userId,
      name: "Timeout eject endpoint",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      timeoutMs: TIMEOUT_MS,
      createdAt: now,
      updatedAt: now,
    });

    const routeSpecs = [
      {
        id: routeOnId,
        name: "Timeout eject on",
        subdomainId: "teject-sub-on",
        l0: "teject-p-on-l0",
        l1: "teject-p-on-l1",
        eject: true,
      },
      {
        id: routeOffId,
        name: "Timeout eject off",
        subdomainId: "teject-sub-off",
        l0: "teject-p-off-l0",
        l1: "teject-p-off-l1",
        eject: false,
      },
      {
        id: routeIsoId,
        name: "Timeout eject iso",
        subdomainId: "teject-sub-iso",
        l0: "teject-p-on-l0",
        l1: "teject-p-iso-l1",
        eject: true,
      },
      {
        id: routeRecId,
        name: "Timeout eject rec",
        subdomainId: "teject-sub-rec",
        l0: "teject-p-rec-l0",
        l1: "teject-p-rec-l1",
        eject: true,
      },
    ];
    await db.insert(endpointRoutes).values(
      routeSpecs.map((r) => ({
        id: r.id,
        name: r.name,
        endpointId,
        subdomainId: r.subdomainId,
        providerId: r.l0,
        providerProtocol: "openai",
        modelId: `${r.l0}-model`,
        retryCount: 0,
        timeoutEjectEnabled: r.eject,
        targets: JSON.stringify([
          { providerId: r.l0, modelId: `${r.l0}-model`, providerProtocol: "openai", bestEffort: false, strategyRoutingEnabled: false, strategyRoutingRules: [] },
          { providerId: r.l1, modelId: `${r.l1}-model`, providerProtocol: "openai", bestEffort: false, strategyRoutingEnabled: false, strategyRoutingRules: [] },
        ]),
        enabled: true,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })),
    );
    await db.insert(routeAuthorizations).values(
      routeSpecs.map((r) => ({
        id: crypto.randomUUID(),
        routeId: r.id,
        userId,
        createdAt: now,
      })),
    );

    const routeRoutes = (await import("../src/routes/routes")).default;
    const gatewayRoutes = (await import("../src/routes/gateway")).default;
    await fastify.register(require("@fastify/jwt"), { secret: "testsecret" });
    fastify.addHook("onRequest", async (request) => {
      request.jwtVerify = async () => {
        (request as any).user = { role: "admin", id: adminId };
      };
    });
    await fastify.register(routeRoutes);
    await fastify.register(gatewayRoutes);
    await fastify.ready();
  }, 30000);

  afterAll(async () => {
    await fastify.close();
    await closeAndCleanup(client, dbFile);
  });

  beforeEach(() => {
    globalTimeoutEjectStore.reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalTimeoutEjectStore.reset();
  });

  function openaiSuccess(model: string, content: string) {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-teject",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  function hangUntilAbort(init: any) {
    return new Promise((_, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      const fail = () => reject(new DOMException("This operation was aborted", "AbortError"));
      if (signal?.aborted) {
        fail();
        return;
      }
      signal?.addEventListener("abort", fail);
    });
  }

  async function chat(host: string, content = "hello") {
    const started = Date.now();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKey}`,
        host,
      },
      payload: {
        model: "ignored",
        messages: [{ role: "user", content }],
        stream: false,
      },
    });
    return { response, elapsedMs: Date.now() - started };
  }

  function stubByHost(handlers: Record<string, (url: string, init?: RequestInit, callIndex: number) => Promise<Response> | Response>) {
    const counts = new Map<string, number>();
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", async (url: any, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, body: String(init?.body || "") });
      for (const [host, handler] of Object.entries(handlers)) {
        if (href.includes(host)) {
          const n = (counts.get(host) || 0) + 1;
          counts.set(host, n);
          return handler(href, init, n);
        }
      }
      return new Response("not-found", { status: 404 });
    });
    return { calls, counts };
  }

  it("persists 超时摘流 default off and PATCH on, and GET exposes live observing", async () => {
    const created = await fastify.inject({
      method: "POST",
      url: "/api/admin/routes",
      payload: {
        name: `teject-admin-${crypto.randomUUID().slice(0, 6)}`,
        hostInput: `teject-admin-${crypto.randomUUID().slice(0, 6)}`,
        path: "/v1/chat/completions",
        incomingProtocol: "openai",
        enabled: true,
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        targets: [{ providerId: "teject-p-on-l0", modelId: "teject-p-on-l0-model", bestEffort: false }],
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json();
    const id = createdBody.id;
    expect(id).toBeTruthy();

    const listed = await fastify.inject({ method: "GET", url: "/api/admin/routes" });
    expect(listed.statusCode).toBe(200);
    const row = listed.json().find((r: any) => r.id === id);
    expect(row.timeoutEjectEnabled).toBe(false);
    expect(row.timeoutEjectObserving).toBe(false);

    const patched = await fastify.inject({
      method: "PATCH",
      url: `/api/admin/routes/${id}`,
      payload: { timeoutEjectEnabled: true },
    });
    expect(patched.statusCode).toBe(200);

    const detail = await fastify.inject({ method: "GET", url: `/api/admin/routes/${id}` });
    expect(detail.json().timeoutEjectEnabled).toBe(true);
    expect(detail.json().timeoutEjectObserving).toBe(false);
  });

  it("with 超时摘流 on, the second request hops L1 without waiting the Timeout budget", async () => {
    stubByHost({
      "teject-l0-on.test": (_url, init) => hangUntilAbort(init) as Promise<Response>,
      "teject-l1-on.test": (_url, _init, _n) => openaiSuccess("teject-p-on-l1-model", "l1-live"),
    });

    const first = await chat("teject-on.example.com");
    expect(first.response.statusCode).toBe(200);
    expect(first.response.json().choices[0].message.content).toBe("l1-live");
    expect(first.elapsedMs).toBeGreaterThan(TIMEOUT_MS - 80);

    const observing = await fastify.inject({ method: "GET", url: `/api/admin/routes/${routeOnId}` });
    expect(observing.json().timeoutEjectEnabled).toBe(true);
    expect(observing.json().timeoutEjectObserving).toBe(true);

    const second = await chat("teject-on.example.com");
    expect(second.response.statusCode).toBe(200);
    expect(second.response.json().choices[0].message.content).toBe("l1-live");
    expect(second.elapsedMs).toBeLessThan(TIMEOUT_MS * 0.6);
  }, 15000);

  it("with 超时摘流 off, a second request still waits on L0", async () => {
    stubByHost({
      "teject-l0-off.test": (_url, init) => hangUntilAbort(init) as Promise<Response>,
      "teject-l1-off.test": () => openaiSuccess("teject-p-off-l1-model", "l1-off"),
    });

    const first = await chat("teject-off.example.com");
    expect(first.response.statusCode).toBe(200);
    expect(first.elapsedMs).toBeGreaterThan(TIMEOUT_MS - 80);

    const second = await chat("teject-off.example.com");
    expect(second.response.statusCode).toBe(200);
    expect(second.response.json().choices[0].message.content).toBe("l1-off");
    expect(second.elapsedMs).toBeGreaterThan(TIMEOUT_MS - 80);
  }, 15000);

  it("probe success clears skip-L0 and probe body is not the client body while ejected", async () => {
    const stub = stubByHost({
      "teject-l0-rec.test": async (_url, init, n) => {
        if (n === 1) return hangUntilAbort(init) as Promise<Response>;
        return openaiSuccess("teject-p-rec-l0-model", "PROBE-SECRET");
      },
      "teject-l1-rec.test": () => openaiSuccess("teject-p-rec-l1-model", "l1-rec"),
    });

    const first = await chat("teject-rec.example.com");
    expect(first.response.statusCode).toBe(200);
    expect(first.response.json().choices[0].message.content).toBe("l1-rec");
    expect(first.response.json().choices[0].message.content).not.toBe("PROBE-SECRET");

    const start = Date.now();
    while (Date.now() - start < 2000) {
      if (!globalTimeoutEjectStore.isEjected({
        routeId: routeRecId,
        providerId: "teject-p-rec-l0",
        modelId: "teject-p-rec-l0-model",
      })) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(globalTimeoutEjectStore.isEjected({
      routeId: routeRecId,
      providerId: "teject-p-rec-l0",
      modelId: "teject-p-rec-l0-model",
    })).toBe(false);

    const recovered = await chat("teject-rec.example.com");
    expect(recovered.response.statusCode).toBe(200);
    expect(recovered.response.json().choices[0].message.content).toBe("PROBE-SECRET");
    expect(stub.counts.get("teject-l0-rec.test") || 0).toBeGreaterThanOrEqual(2);
  }, 15000);

  it("does not skip L0 on a sibling route that shares a provider identity pattern", async () => {
    stubByHost({
      "teject-l0-on.test": (_url, init) => hangUntilAbort(init) as Promise<Response>,
      "teject-l1-on.test": () => openaiSuccess("teject-p-on-l1-model", "l1-on"),
      "teject-l1-iso.test": () => openaiSuccess("teject-p-iso-l1-model", "l1-iso"),
    });

    const first = await chat("teject-on.example.com");
    expect(first.response.statusCode).toBe(200);
    expect(globalTimeoutEjectStore.observingForRoute(routeOnId)).toBe(true);
    expect(globalTimeoutEjectStore.observingForRoute(routeIsoId)).toBe(false);

    const iso = await chat("teject-iso.example.com");
    expect(iso.response.statusCode).toBe(200);
    expect(iso.response.json().choices[0].message.content).toBe("l1-iso");
    expect(iso.elapsedMs).toBeGreaterThan(TIMEOUT_MS - 80);
  }, 15000);

  it("Routes list/edit source renders 超时摘流 and list observing state from the live payload", () => {
    const webSrc = process.cwd().endsWith("server")
      ? path.resolve(process.cwd(), "../../apps/web/src")
      : path.resolve(process.cwd(), "apps/web/src");
    const dialog = fs.readFileSync(path.join(webSrc, "components/Routes/RouteDialog.tsx"), "utf8");
    const list = fs.readFileSync(path.join(webSrc, "components/Routes/RouteList.tsx"), "utf8");
    const save = fs.readFileSync(path.join(webSrc, "components/Routes/useRoutesState.ts"), "utf8");
    expect(dialog).toMatch(/超时摘流/);
    expect(dialog).toMatch(/timeoutEjectEnabled/);
    expect(list).toMatch(/timeoutEjectObserving/);
    expect(list).toMatch(/摘流中/);
    expect(save).toMatch(/timeoutEjectEnabled: !!formData\.timeoutEjectEnabled/);
  });
});
