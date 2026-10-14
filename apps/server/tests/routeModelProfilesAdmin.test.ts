import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";

const dbFile = "data/promptgate_test_route_model_profiles_admin.sqlite";

describe("route model profiles admin API", () => {
  const fastify = Fastify({ logger: false });
  let db: any;
  let client: any;
  let endpointRoutes: any;
  const providerId = "rmpa-provider";

  beforeAll(async () => {
    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));
    const schema = await import("../src/db/schema");
    endpointRoutes = schema.endpointRoutes;
    const now = new Date();

    await db.insert(schema.providers).values({
      id: providerId,
      name: "rmpa provider",
      openaiBaseUrl: "https://rmpa.test/v1",
      enabled: true,
      concurrencyLimit: 10,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.providerModels).values(
      ["base-model", "cheap-model", "max-model"].map((modelId) => ({
        id: crypto.randomUUID(),
        providerId,
        modelId,
        displayName: modelId,
        enabled: true,
        active: true,
        createdAt: now,
      })),
    );
    await db
      .update(schema.systemSettings)
      .set({ value: "example.com", updatedAt: now })
      .where(eq(schema.systemSettings.key, "mainDomain"));

    const routeRoutes = (await import("../src/routes/routes")).default;
    await fastify.register(require("@fastify/jwt"), { secret: "testsecret" });
    fastify.addHook("onRequest", async (request) => {
      request.jwtVerify = async () => {
        (request as any).user = { role: "admin", id: "admin-rmpa" };
      };
    });
    await fastify.register(routeRoutes);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    await closeAndCleanup(client, dbFile);
  });

  const target = (modelId: string) => ({ providerId, modelId, bestEffort: false });

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      name: `rmpa-${crypto.randomUUID().slice(0, 8)}`,
      hostInput: "*",
      path: `/v1/rmpa-${crypto.randomUUID().slice(0, 8)}`,
      incomingProtocol: "openai",
      enabled: true,
      routingMode: "classic",
      targets: [target("base-model")],
      ...overrides,
    };
  }

  const create = (body: Record<string, unknown>) =>
    fastify.inject({ method: "POST", url: "/api/admin/routes", payload: body });
  const patch = (id: string, body: Record<string, unknown>) =>
    fastify.inject({ method: "PATCH", url: `/api/admin/routes/${id}`, payload: body });
  const get = (id: string) => fastify.inject({ method: "GET", url: `/api/admin/routes/${id}` });
  const row = async (id: string) =>
    (await db.select().from(endpointRoutes).where(eq(endpointRoutes.id, id)))[0];

  it("a route created without modelProfiles stores NULL and reads back an empty list", async () => {
    const res = await create(payload());
    expect(res.statusCode).toBe(201);
    const { id } = res.json();
    expect((await row(id)).modelProfiles).toBeNull();
    expect((await get(id)).json().modelProfiles).toEqual([]);
  });

  it("creates, reads, keeps on unrelated PATCH, replaces, and clears profiles", async () => {
    const res = await create(
      payload({
        modelProfiles: [
          { name: " Yutrix-Cheap ", routingMode: "classic", targets: [target("cheap-model")] },
          { name: "yutrix-max", routingMode: "classic", targets: [target("max-model"), target("base-model")] },
        ],
      }),
    );
    expect(res.statusCode).toBe(201);
    const { id } = res.json();

    const stored = JSON.parse((await row(id)).modelProfiles);
    expect(stored.map((p: any) => p.name)).toEqual(["Yutrix-Cheap", "yutrix-max"]);
    expect(stored[0].targets[0]).toMatchObject({ providerId, modelId: "cheap-model", providerProtocol: "openai" });

    const detail = (await get(id)).json();
    expect(detail.modelProfiles).toHaveLength(2);
    expect(detail.modelProfiles[1].targets).toHaveLength(2);
    // Default table untouched by profiles.
    expect(detail.targets[0].modelId).toBe("base-model");

    // Old clients / toggles that don't send modelProfiles must not wipe them.
    expect((await patch(id, { enabled: false })).statusCode).toBe(200);
    expect(JSON.parse((await row(id)).modelProfiles)).toHaveLength(2);

    expect(
      (await patch(id, { modelProfiles: [{ name: "only", routingMode: "classic", targets: [target("max-model")] }] }))
        .statusCode,
    ).toBe(200);
    expect(JSON.parse((await row(id)).modelProfiles).map((p: any) => p.name)).toEqual(["only"]);

    expect((await patch(id, { modelProfiles: [] })).statusCode).toBe(200);
    expect((await row(id)).modelProfiles).toBeNull();
  });

  it("rejects duplicate, reserved, and invalid-target profiles without touching the row", async () => {
    const res = await create(payload());
    const { id } = res.json();

    const dup = await patch(id, {
      modelProfiles: [
        { name: "a", routingMode: "classic", targets: [target("cheap-model")] },
        { name: "A", routingMode: "classic", targets: [target("max-model")] },
      ],
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error).toContain("重复");

    const reserved = await patch(id, {
      modelProfiles: [{ name: "default", routingMode: "classic", targets: [target("cheap-model")] }],
    });
    expect(reserved.statusCode).toBe(400);

    const noTargets = await patch(id, { modelProfiles: [{ name: "x", routingMode: "classic", targets: [] }] });
    expect(noTargets.statusCode).toBe(400);
    expect(noTargets.json().error).toContain("x");

    const badProvider = await create(
      payload({
        modelProfiles: [{ name: "x", routingMode: "classic", targets: [{ providerId: "missing", modelId: "m" }] }],
      }),
    );
    expect(badProvider.statusCode).toBe(400);

    const notArray = await patch(id, { modelProfiles: { name: "x" } });
    expect(notArray.statusCode).toBe(400);

    expect((await row(id)).modelProfiles).toBeNull();
  });
});
