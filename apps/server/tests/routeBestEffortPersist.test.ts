import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import { buildCopiedRouteDraft } from "@promptgate/shared";

const dbFile = "data/promptgate_test_route_best_effort_persist.sqlite";

describe("route best effort (fallbackMatchTarget) persistence", () => {
  const fastify = Fastify({ logger: false });
  let db: any;
  let client: any;
  let providers: any;
  let providerModels: any;
  let endpointRoutes: any;
  let systemSettings: any;

  let provider1Id = "";
  let provider2Id = "";
  const model1Id = "gpt-4o-primary";
  const model2Id = "claude-3-5-sonnet-fallback";

  beforeAll(async () => {
    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));
    ({ providers, providerModels, endpointRoutes, systemSettings } = await import("../src/db/schema"));

    provider1Id = crypto.randomUUID();
    await db.insert(providers).values({
      id: provider1Id,
      name: "Primary Test Provider",
      openaiBaseUrl: "https://api.openai.com/v1",
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: provider1Id,
      modelId: model1Id,
      displayName: "GPT-4o",
      enabled: true,
      active: true,
      createdAt: new Date(),
    });

    provider2Id = crypto.randomUUID();
    await db.insert(providers).values({
      id: provider2Id,
      name: "Fallback Test Provider",
      openaiBaseUrl: "https://api.openai.com/v1",
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId: provider2Id,
      modelId: model2Id,
      displayName: "Claude 3.5 Sonnet",
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
        (request as any).user = { role: "admin", id: "admin-route-test" };
      };
    });
    await fastify.register(routeRoutes);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    await closeAndCleanup(client, dbFile);
  });

  function makePayload(overrides: Record<string, unknown> = {}) {
    return {
      name: `route-${crypto.randomUUID().slice(0, 8)}`,
      hostInput: "*",
      path: `/v1/chat-${crypto.randomUUID().slice(0, 8)}`,
      incomingProtocol: "openai",
      enabled: true,
      targets: [{ providerId: provider1Id, modelId: model1Id, bestEffort: false }],
      ...overrides,
    };
  }

  async function createRoute(body: Record<string, unknown>) {
    return fastify.inject({
      method: "POST",
      url: "/api/admin/routes",
      payload: body,
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

  it("POST create with fallbackMatchTarget: true -> row has it true; GET returns true", async () => {
    const payload = makePayload({ fallbackMatchTarget: true });
    const res = await createRoute(payload);
    expect(res.statusCode).toBe(201);
    const { id } = JSON.parse(res.body);

    // Verify directly in DB
    const rows = await db.select().from(endpointRoutes).where(eq(endpointRoutes.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].fallbackMatchTarget).toBe(true);

    // Verify GET by ID
    const getRes = await getRoute(id);
    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.body);
    expect(getBody.fallbackMatchTarget).toBe(true);

    // Verify GET list
    const listRes = await listRoutes();
    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body);
    const found = list.find((r: any) => r.id === id);
    expect(found).toBeDefined();
    expect(found.fallbackMatchTarget).toBe(true);
  });

  it("POST create with fallbackMatchTarget: false -> false", async () => {
    const payload = makePayload({ fallbackMatchTarget: false });
    const res = await createRoute(payload);
    expect(res.statusCode).toBe(201);
    const { id } = JSON.parse(res.body);

    const rows = await db.select().from(endpointRoutes).where(eq(endpointRoutes.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].fallbackMatchTarget).toBe(false);

    const getRes = await getRoute(id);
    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.body);
    expect(getBody.fallbackMatchTarget).toBe(false);
  });

  it("POST create with fallbackMatchTarget absent -> defaults to false", async () => {
    const payload = makePayload();
    delete (payload as any).fallbackMatchTarget;
    const res = await createRoute(payload);
    expect(res.statusCode).toBe(201);
    const { id } = JSON.parse(res.body);

    const rows = await db.select().from(endpointRoutes).where(eq(endpointRoutes.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].fallbackMatchTarget).toBe(false);

    const getRes = await getRoute(id);
    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.body);
    expect(getBody.fallbackMatchTarget).toBe(false);
  });

  it("PATCH set true -> true; PATCH unrelated field -> previous true is preserved", async () => {
    // Start with route having fallbackMatchTarget: false
    const initial = await createRoute(makePayload({ fallbackMatchTarget: false }));
    expect(initial.statusCode).toBe(201);
    const { id } = JSON.parse(initial.body);

    // PATCH to true
    const patchRes1 = await patchRoute(id, { fallbackMatchTarget: true });
    expect(patchRes1.statusCode).toBe(200);

    const rows1 = await db.select().from(endpointRoutes).where(eq(endpointRoutes.id, id));
    expect(rows1[0].fallbackMatchTarget).toBe(true);

    const getRes1 = await getRoute(id);
    expect(JSON.parse(getRes1.body).fallbackMatchTarget).toBe(true);

    // PATCH unrelated field only (name change, no fallbackMatchTarget key)
    const newName = `renamed-${crypto.randomUUID().slice(0, 8)}`;
    const patchRes2 = await patchRoute(id, { name: newName });
    expect(patchRes2.statusCode).toBe(200);

    // Previous true MUST be preserved
    const rows2 = await db.select().from(endpointRoutes).where(eq(endpointRoutes.id, id));
    expect(rows2[0].name).toBe(newName);
    expect(rows2[0].fallbackMatchTarget).toBe(true);

    const getRes2 = await getRoute(id);
    const getBody2 = JSON.parse(getRes2.body);
    expect(getBody2.name).toBe(newName);
    expect(getBody2.fallbackMatchTarget).toBe(true);
  });

  it("PATCH explicit false -> false", async () => {
    // Start with route having fallbackMatchTarget: true
    const initial = await createRoute(makePayload({ fallbackMatchTarget: true }));
    expect(initial.statusCode).toBe(201);
    const { id } = JSON.parse(initial.body);

    const beforeRows = await db.select().from(endpointRoutes).where(eq(endpointRoutes.id, id));
    expect(beforeRows[0].fallbackMatchTarget).toBe(true);

    // PATCH explicit false
    const patchRes = await patchRoute(id, { fallbackMatchTarget: false });
    expect(patchRes.statusCode).toBe(200);

    const afterRows = await db.select().from(endpointRoutes).where(eq(endpointRoutes.id, id));
    expect(afterRows[0].fallbackMatchTarget).toBe(false);

    const getRes = await getRoute(id);
    expect(JSON.parse(getRes.body).fallbackMatchTarget).toBe(false);
  });

  it("Copy-shaped payload (targets with per-target bestEffort: true + global flag true) -> both persisted and readable", async () => {
    const copyPayload = makePayload({
      name: "Source Route For Copy",
      fallbackMatchTarget: true,
      targets: [
        { providerId: provider1Id, modelId: model1Id, bestEffort: false },
        { providerId: provider2Id, modelId: model2Id, bestEffort: true },
      ],
    });

    const createRes = await createRoute(copyPayload);
    expect(createRes.statusCode).toBe(201);
    const sourceId = JSON.parse(createRes.body).id;

    // Check DB row directly
    const sourceRows = await db.select().from(endpointRoutes).where(eq(endpointRoutes.id, sourceId));
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0].fallbackMatchTarget).toBe(true);
    const parsedDbTargets = JSON.parse(sourceRows[0].targets);
    expect(parsedDbTargets).toHaveLength(2);
    expect(parsedDbTargets[0].bestEffort).toBe(false);
    expect(parsedDbTargets[1].bestEffort).toBe(true);

    // Check GET
    const getSourceRes = await getRoute(sourceId);
    expect(getSourceRes.statusCode).toBe(200);
    const sourceData = JSON.parse(getSourceRes.body);
    expect(sourceData.fallbackMatchTarget).toBe(true);
    expect(sourceData.targets).toHaveLength(2);
    expect(sourceData.targets[0].bestEffort).toBe(false);
    expect(sourceData.targets[1].bestEffort).toBe(true);

    // Test client copy flow: buildCopiedRouteDraft -> save copied route
    const draft = buildCopiedRouteDraft(
      {
        name: sourceData.name,
        host: sourceData.host,
        path: sourceData.path,
        incomingProtocol: sourceData.incomingProtocol,
        targets: sourceData.targets,
        timeoutMs: sourceData.timeoutMs,
        retryCount: sourceData.retryCount,
        queueTimeoutMs: sourceData.queueTimeoutMs,
        maxBodyMb: sourceData.maxBodyMb,
        enabled: sourceData.enabled,
        allowClientModel: sourceData.allowClientModel,
        ipWhitelist: sourceData.ipWhitelist,
        authorizedUserIds: sourceData.authorizedUserIds,
        authorizedGroupIds: sourceData.authorizedGroupIds,
        fallbackMatchTarget: sourceData.fallbackMatchTarget,
        schedules: sourceData.schedules,
      },
      [sourceData.name],
      "副本",
    );

    expect(draft.fallbackMatchTarget).toBe(true);
    expect((draft.targets as any[])[1].bestEffort).toBe(true);

    // To avoid path/host collision with the source route, set a new path for the copy
    const copiedPayload = {
      ...draft,
      path: `/v1/chat-copied-${crypto.randomUUID().slice(0, 8)}`,
    };

    const copyRes = await createRoute(copiedPayload);
    expect(copyRes.statusCode).toBe(201);
    const copyId = JSON.parse(copyRes.body).id;
    expect(copyId).not.toBe(sourceId);

    // Verify copied route in DB
    const copyRows = await db.select().from(endpointRoutes).where(eq(endpointRoutes.id, copyId));
    expect(copyRows).toHaveLength(1);
    expect(copyRows[0].fallbackMatchTarget).toBe(true);
    const parsedCopyDbTargets = JSON.parse(copyRows[0].targets);
    expect(parsedCopyDbTargets[1].bestEffort).toBe(true);

    // Verify copied route via GET
    const getCopyRes = await getRoute(copyId);
    expect(getCopyRes.statusCode).toBe(200);
    const copyData = JSON.parse(getCopyRes.body);
    expect(copyData.fallbackMatchTarget).toBe(true);
    expect(copyData.targets).toHaveLength(2);
    expect(copyData.targets[0].bestEffort).toBe(false);
    expect(copyData.targets[1].bestEffort).toBe(true);
  });
});
