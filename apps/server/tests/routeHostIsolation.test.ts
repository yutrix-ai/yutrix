import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import { ROUTE_IDENTITY_ERROR } from "@promptgate/shared";

const dbFile = "data/promptgate_test_route_host_isolation.sqlite";

describe("route Host bind isolation (shared subdomain)", () => {
  const fastify = Fastify({ logger: false });
  let db: any;
  let client: any;
  let providers: any;
  let providerModels: any;
  let systemSettings: any;
  let subdomains: any;
  let providerId = "";
  const modelId = "gpt-4o-host-iso";

  beforeAll(async () => {
    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));
    ({ providers, providerModels, systemSettings, subdomains } = await import("../src/db/schema"));
    providerId = crypto.randomUUID();
    await db.insert(providers).values({
      id: providerId,
      name: "Host Isolation Provider",
      openaiBaseUrl: "https://api.openai.com/v1",
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId,
      modelId,
      displayName: "GPT-4o",
      enabled: true,
      active: true,
      createdAt: new Date(),
    });
    await db
      .update(systemSettings)
      .set({ value: "example.com", updatedAt: new Date() })
      .where(eq(systemSettings.key, "mainDomain"));

    const routeRoutes = (await import("../src/routes/routes")).default;
    await fastify.register(require("@fastify/jwt"), { secret: "testsecret" });
    fastify.addHook("onRequest", async (request) => {
      request.jwtVerify = async () => {
        (request as any).user = { role: "admin", id: "admin-host-iso" };
      };
    });
    await fastify.register(routeRoutes);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    await closeAndCleanup(client, dbFile);
  });

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      name: `route-${crypto.randomUUID().slice(0, 8)}`,
      hostInput: "*",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      targets: [{ providerId, modelId, bestEffort: false }],
      ...overrides,
    };
  }

  async function createRoute(overrides: Record<string, unknown> = {}) {
    return fastify.inject({
      method: "POST",
      url: "/api/admin/routes",
      payload: payload(overrides),
    });
  }

  async function patchRoute(id: string, body: Record<string, unknown>) {
    return fastify.inject({
      method: "PATCH",
      url: `/api/admin/routes/${id}`,
      payload: body,
    });
  }

  async function getRoute(id: string) {
    return fastify.inject({
      method: "GET",
      url: `/api/admin/routes/${id}`,
    });
  }

  async function listRoutes() {
    return fastify.inject({
      method: "GET",
      url: "/api/admin/routes",
    });
  }

  async function deleteRoute(id: string) {
    return fastify.inject({
      method: "DELETE",
      url: `/api/admin/routes/${id}`,
    });
  }

  it("PATCH of one shared-Host route does not rewrite sibling Host in GET or list", async () => {
    const sharedHost = `openrouter.shared-${crypto.randomUUID().slice(0, 8)}.zhenhub.cn`;
    const newHost = `openrouter.moved-${crypto.randomUUID().slice(0, 8)}.zhenhub.cn`;

    const messages = await createRoute({
      name: `iso-msg-${crypto.randomUUID().slice(0, 8)}`,
      hostInput: sharedHost,
      path: "/v1/messages",
      incomingProtocol: "anthropic",
    });
    const completions = await createRoute({
      name: `iso-chat-${crypto.randomUUID().slice(0, 8)}`,
      hostInput: sharedHost,
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
    });
    expect(messages.statusCode).toBe(201);
    expect(completions.statusCode).toBe(201);
    const messagesId = JSON.parse(messages.body).id;
    const completionsId = JSON.parse(completions.body).id;

    const beforeSibling = JSON.parse((await getRoute(messagesId)).body);
    expect(beforeSibling.host).toBe(sharedHost);

    const patched = await patchRoute(completionsId, {
      hostInput: newHost,
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
    });
    expect(patched.statusCode).toBe(200);

    const afterEdited = JSON.parse((await getRoute(completionsId)).body);
    const afterSibling = JSON.parse((await getRoute(messagesId)).body);
    expect(afterEdited.host).toBe(newHost);
    expect(afterSibling.host).toBe(sharedHost);
    expect(afterSibling.host).not.toBe(afterEdited.host);

    const listed = JSON.parse((await listRoutes()).body) as Array<{ id: string; host: string }>;
    expect(listed.find((row) => row.id === messagesId)?.host).toBe(sharedHost);
    expect(listed.find((row) => row.id === completionsId)?.host).toBe(newHost);

    const leftover = await db.select().from(subdomains).where(eq(subdomains.hostname, sharedHost));
    expect(leftover).toHaveLength(1);
    expect(leftover[0].hostname).toBe(sharedHost);
    expect(leftover[0].id).toBe(afterSibling.subdomainId);

    const deleted = await deleteRoute(messagesId);
    expect(deleted.statusCode).toBe(200);
    const cleaned = await db.select().from(subdomains).where(eq(subdomains.hostname, sharedHost));
    expect(cleaned).toHaveLength(0);
    const stillEdited = JSON.parse((await getRoute(completionsId)).body);
    expect(stillEdited.host).toBe(newHost);
  });

  it("rebinding to an already-existing hostname reuses that row and does not rewrite it", async () => {
    const alphaHost = `alpha-${crypto.randomUUID().slice(0, 8)}.keep.example`;
    const betaHost = `beta-${crypto.randomUUID().slice(0, 8)}.keep.example`;

    const alpha = await createRoute({
      name: `keep-a-${crypto.randomUUID().slice(0, 8)}`,
      hostInput: alphaHost,
      path: "/v1/messages",
      incomingProtocol: "anthropic",
      description: "alpha-description",
    });
    const beta = await createRoute({
      name: `keep-b-${crypto.randomUUID().slice(0, 8)}`,
      hostInput: betaHost,
      path: "/v1/chat/completions",
    });
    expect(alpha.statusCode).toBe(201);
    expect(beta.statusCode).toBe(201);
    const alphaId = JSON.parse(alpha.body).id;
    const betaId = JSON.parse(beta.body).id;

    const alphaBefore = JSON.parse((await getRoute(alphaId)).body);
    const alphaRowsBefore = await db.select().from(subdomains).where(eq(subdomains.hostname, alphaHost));
    expect(alphaRowsBefore).toHaveLength(1);
    const alphaSubdomainId = alphaRowsBefore[0].id;

    const patched = await patchRoute(betaId, {
      hostInput: alphaHost,
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
    });
    expect(patched.statusCode).toBe(200);

    const alphaAfter = JSON.parse((await getRoute(alphaId)).body);
    const betaAfter = JSON.parse((await getRoute(betaId)).body);
    expect(alphaAfter.host).toBe(alphaHost);
    expect(betaAfter.host).toBe(alphaHost);
    expect(alphaAfter.host).toBe(alphaBefore.host);
    expect(betaAfter.subdomainId).toBe(alphaSubdomainId);
    expect(alphaAfter.subdomainId).toBe(alphaSubdomainId);

    const alphaRowsAfter = await db.select().from(subdomains).where(eq(subdomains.hostname, alphaHost));
    expect(alphaRowsAfter).toHaveLength(1);
    expect(alphaRowsAfter[0].id).toBe(alphaSubdomainId);
    expect(alphaRowsAfter[0].hostname).toBe(alphaHost);

    const betaGone = await db.select().from(subdomains).where(eq(subdomains.hostname, betaHost));
    expect(betaGone).toHaveLength(0);
  });

  it("allows two independent hosts that share a first label without rewriting either hostname", async () => {
    const stem = `openrouter-${crypto.randomUUID().slice(0, 8)}`;
    const hostA = `${stem}.test.zhenhub.cn`;
    const hostB = `${stem}.prod.zhenhub.cn`;

    const routeA = await createRoute({
      name: `label-a-${crypto.randomUUID().slice(0, 8)}`,
      hostInput: hostA,
      path: "/v1/messages",
      incomingProtocol: "anthropic",
    });
    const routeB = await createRoute({
      name: `label-b-${crypto.randomUUID().slice(0, 8)}`,
      hostInput: hostB,
      path: "/v1/chat/completions",
    });
    expect(routeA.statusCode).toBe(201);
    expect(routeB.statusCode).toBe(201);

    const afterA = JSON.parse((await getRoute(JSON.parse(routeA.body).id)).body);
    const afterB = JSON.parse((await getRoute(JSON.parse(routeB.body).id)).body);
    expect(afterA.host).toBe(hostA);
    expect(afterB.host).toBe(hostB);
    expect(afterA.subdomainId).not.toBe(afterB.subdomainId);

    const rowsA = await db.select().from(subdomains).where(eq(subdomains.hostname, hostA));
    const rowsB = await db.select().from(subdomains).where(eq(subdomains.hostname, hostB));
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0].name).toBe(stem);
    expect(rowsB[0].name).toBe(stem);
  });

  it("still rejects duplicate Host+Path+Protocol after isolated host binds", async () => {
    const host = `dup-${crypto.randomUUID().slice(0, 8)}.zhenhub.cn`;
    const first = await createRoute({
      name: `dup-a-${crypto.randomUUID().slice(0, 8)}`,
      hostInput: host,
    });
    expect(first.statusCode).toBe(201);

    const second = await createRoute({
      name: `dup-b-${crypto.randomUUID().slice(0, 8)}`,
      hostInput: host,
    });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    expect(second.statusCode).toBeLessThan(500);
    expect(JSON.parse(second.body).code).toBe(ROUTE_IDENTITY_ERROR.MATCHING_KEY_CONFLICT);

    const patchClash = await patchRoute(JSON.parse(first.body).id, {
      hostInput: host,
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
    });
    expect(patchClash.statusCode).toBe(200);

    const other = await createRoute({
      name: `dup-c-${crypto.randomUUID().slice(0, 8)}`,
      hostInput: `other-${crypto.randomUUID().slice(0, 8)}.zhenhub.cn`,
    });
    expect(other.statusCode).toBe(201);
    const clash = await patchRoute(JSON.parse(other.body).id, {
      hostInput: host,
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
    });
    expect(clash.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(clash.body).code).toBe(ROUTE_IDENTITY_ERROR.MATCHING_KEY_CONFLICT);
  });
});
