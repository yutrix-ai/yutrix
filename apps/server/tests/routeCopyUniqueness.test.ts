import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import {
  ROUTE_IDENTITY_ERROR,
  ROUTE_IDENTITY_ERROR_MESSAGE,
} from "@promptgate/shared";

const dbFile = "data/promptgate_test_route_copy_uniqueness.sqlite";

describe("admin route identity uniqueness (create/update)", () => {
  const fastify = Fastify({ logger: false });
  let db: any;
  let client: any;
  let providers: any;
  let providerModels: any;
  let systemSettings: any;
  let providerId = "";
  const modelId = "gpt-4o-route-copy";

  beforeAll(async () => {
    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));
    ({ providers, providerModels, systemSettings } = await import("../src/db/schema"));
    providerId = crypto.randomUUID();
    await db.insert(providers).values({
      id: providerId,
      name: "Route Copy Test Provider",
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
        (request as any).user = { role: "admin", id: "admin-route-copy" };
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

  it("rejects duplicate name even when the matching triple differs", async () => {
    const name = `same-name-${crypto.randomUUID().slice(0, 8)}`;
    const first = await createRoute({ name, hostInput: "alpha" });
    expect(first.statusCode).toBe(201);

    const second = await createRoute({
      name,
      hostInput: "beta",
      path: "/v1/messages",
      incomingProtocol: "anthropic",
    });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    expect(second.statusCode).toBeLessThan(500);
    const body = JSON.parse(second.body);
    expect(body.code).toBe(ROUTE_IDENTITY_ERROR.NAME_CONFLICT);
    expect(body.error).toBe(ROUTE_IDENTITY_ERROR_MESSAGE[ROUTE_IDENTITY_ERROR.NAME_CONFLICT]);
    expect(body.code).not.toBe(ROUTE_IDENTITY_ERROR.MATCHING_KEY_CONFLICT);
  });

  it("rejects duplicate host+path+protocol even when the name differs", async () => {
    const hostInput = `triple-${crypto.randomUUID().slice(0, 8)}`;
    const first = await createRoute({ name: `${hostInput}-a`, hostInput });
    expect(first.statusCode).toBe(201);

    const second = await createRoute({ name: `${hostInput}-b`, hostInput });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    expect(second.statusCode).toBeLessThan(500);
    const body = JSON.parse(second.body);
    expect(body.code).toBe(ROUTE_IDENTITY_ERROR.MATCHING_KEY_CONFLICT);
    expect(body.error).toBe(
      ROUTE_IDENTITY_ERROR_MESSAGE[ROUTE_IDENTITY_ERROR.MATCHING_KEY_CONFLICT],
    );
    expect(body.code).not.toBe(ROUTE_IDENTITY_ERROR.NAME_CONFLICT);
  });

  it("allows * and a specific host with the same path and protocol", async () => {
    const path = `/v1/wild-${crypto.randomUUID().slice(0, 8)}`;
    const wildcard = await createRoute({
      name: `wild-${crypto.randomUUID().slice(0, 8)}`,
      hostInput: "*",
      path,
    });
    expect(wildcard.statusCode).toBe(201);

    const specific = await createRoute({
      name: `specific-${crypto.randomUUID().slice(0, 8)}`,
      hostInput: `spec-${crypto.randomUUID().slice(0, 8)}`,
      path,
    });
    expect(specific.statusCode).toBe(201);
    expect(JSON.parse(specific.body).id).not.toBe(JSON.parse(wildcard.body).id);
  });

  it("treats prefix host and prefix.{mainDomain} as the same matching key", async () => {
    const prefix = `fqdn-${crypto.randomUUID().slice(0, 8)}`;
    const first = await createRoute({ name: `${prefix}-one`, hostInput: prefix });
    expect(first.statusCode).toBe(201);

    const second = await createRoute({
      name: `${prefix}-two`,
      hostInput: `${prefix}.example.com`,
    });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    expect(second.statusCode).toBeLessThan(500);
    expect(JSON.parse(second.body).code).toBe(ROUTE_IDENTITY_ERROR.MATCHING_KEY_CONFLICT);
  });

  it("PATCH of a route does not collide with itself", async () => {
    const name = `self-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createRoute({ name, hostInput: name });
    expect(created.statusCode).toBe(201);
    const id = JSON.parse(created.body).id;

    const patched = await patchRoute(id, {
      name,
      hostInput: `${name}.example.com`,
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
    });
    expect(patched.statusCode).toBe(200);
  });

  it("a disabled route still occupies both identity keys", async () => {
    const stem = `off-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createRoute({ name: stem, hostInput: stem, enabled: true });
    expect(created.statusCode).toBe(201);
    const id = JSON.parse(created.body).id;

    const disabled = await patchRoute(id, { enabled: false });
    expect(disabled.statusCode).toBe(200);

    const nameClash = await createRoute({
      name: stem,
      hostInput: `${stem}-other`,
    });
    expect(nameClash.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(nameClash.body).code).toBe(ROUTE_IDENTITY_ERROR.NAME_CONFLICT);

    const keyClash = await createRoute({
      name: `${stem}-new`,
      hostInput: stem,
    });
    expect(keyClash.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(keyClash.body).code).toBe(ROUTE_IDENTITY_ERROR.MATCHING_KEY_CONFLICT);
  });

  it("rejects empty and whitespace-only names", async () => {
    const empty = await createRoute({ name: "" });
    expect(empty.statusCode).toBeGreaterThanOrEqual(400);
    expect(empty.statusCode).toBeLessThan(500);
    expect(JSON.parse(empty.body).code).toBe(ROUTE_IDENTITY_ERROR.NAME_REQUIRED);

    const blank = await createRoute({ name: "   " });
    expect(blank.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(blank.body).code).toBe(ROUTE_IDENTITY_ERROR.NAME_REQUIRED);
  });

  it("copy-equivalent POST with a free Host creates a new id and leaves the source unchanged", async () => {
    const stem = `copy-${crypto.randomUUID().slice(0, 8)}`;
    const sourcePayload = payload({
      name: stem,
      hostInput: stem,
      retryCount: 5,
      timeoutMs: 12000,
      allowClientModel: true,
      ipWhitelist: "10.0.0.1",
    });
    const source = await createRoute(sourcePayload);
    expect(source.statusCode).toBe(201);
    const sourceId = JSON.parse(source.body).id;
    const before = JSON.parse((await getRoute(sourceId)).body);

    const copied = await createRoute({
      name: `${stem} 副本`,
      hostInput: `${stem}-copy`,
      retryCount: 5,
      timeoutMs: 12000,
      allowClientModel: true,
      ipWhitelist: "10.0.0.1",
    });
    expect(copied.statusCode).toBe(201);
    const copyId = JSON.parse(copied.body).id;
    expect(copyId).not.toBe(sourceId);

    const after = JSON.parse((await getRoute(sourceId)).body);
    expect(after.id).toBe(sourceId);
    expect(after.name).toBe(before.name);
    expect(after.host).toBe(before.host);
    expect(after.path).toBe(before.path);
    expect(after.incomingProtocol).toBe(before.incomingProtocol);
    expect(after.retryCount).toBe(before.retryCount);
    expect(after.timeoutMs).toBe(before.timeoutMs);

    const failedSameTriple = await createRoute({
      name: `${stem} 副本 2`,
      hostInput: stem,
    });
    expect(failedSameTriple.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(failedSameTriple.body).code).toBe(
      ROUTE_IDENTITY_ERROR.MATCHING_KEY_CONFLICT,
    );
    const still = JSON.parse((await getRoute(sourceId)).body);
    expect(still.name).toBe(before.name);
    expect(still.host).toBe(before.host);
  });

  it("PATCH that only changes name still fails on a colliding triple", async () => {
    const a = `patch-a-${crypto.randomUUID().slice(0, 8)}`;
    const b = `patch-b-${crypto.randomUUID().slice(0, 8)}`;
    const first = await createRoute({ name: a, hostInput: a });
    const second = await createRoute({ name: b, hostInput: b });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const secondId = JSON.parse(second.body).id;

    const clash = await patchRoute(secondId, {
      name: `${b}-renamed`,
      hostInput: a,
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
    });
    expect(clash.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(clash.body).code).toBe(ROUTE_IDENTITY_ERROR.MATCHING_KEY_CONFLICT);
  });

  it("PATCH that only changes the triple still fails on a colliding name", async () => {
    const a = `pname-a-${crypto.randomUUID().slice(0, 8)}`;
    const b = `pname-b-${crypto.randomUUID().slice(0, 8)}`;
    const first = await createRoute({ name: a, hostInput: a });
    const second = await createRoute({ name: b, hostInput: b });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const secondId = JSON.parse(second.body).id;

    const clash = await patchRoute(secondId, {
      name: a,
      hostInput: `${b}-moved`,
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
    });
    expect(clash.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(clash.body).code).toBe(ROUTE_IDENTITY_ERROR.NAME_CONFLICT);
  });
});
