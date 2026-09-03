import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import {
  isMaintenanceMode,
  setMaintenanceMode,
  incrementInFlight,
  decrementInFlight,
  getInFlightCount,
  drainRequests,
} from "../src/services/maintenance";
import { ERR_MAINTENANCE_ACTIVE, ERR_MAINTENANCE_ACTIVE_MESSAGE } from "@promptgate/shared";

describe("Slice P1: Maintenance Mode & Drain Tests", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    await setMaintenanceMode(false);
    app = Fastify();
    await app.register(cookie);
    await app.register(jwt, { secret: "maintenance-test-secret-at-least-32-chars-long" });

    // Request tracking & maintenance gate hook
    app.addHook("onRequest", async (request, reply) => {
      incrementInFlight();

      if (isMaintenanceMode()) {
        const url = request.url.split("?")[0];
        if (url.startsWith("/v1/") || url.startsWith("/v0/")) {
          return reply
            .header("Retry-After", "30")
            .code(503)
            .send({
              error: {
                message: ERR_MAINTENANCE_ACTIVE_MESSAGE,
                type: "maintenance_active",
                code: ERR_MAINTENANCE_ACTIVE,
              },
            });
        }
        if (
          request.method !== "GET" &&
          request.method !== "HEAD" &&
          request.method !== "OPTIONS"
        ) {
          if (!url.startsWith("/api/settings/database")) {
            return reply.code(503).send({
              error: "System maintenance in progress",
              code: ERR_MAINTENANCE_ACTIVE,
              message: ERR_MAINTENANCE_ACTIVE_MESSAGE,
            });
          }
        }
      }
    });

    app.addHook("onResponse", async () => {
      decrementInFlight();
    });

    // Sample routes
    app.post("/v1/chat/completions", async () => ({ id: "chatcmpl-1" }));
    app.post("/v0/models", async () => ({ models: [] }));
    app.post("/api/users", async () => ({ ok: true }));
    app.get("/api/settings/database", async () => ({ driver: "sqlite" }));
    app.post("/api/settings/database/test", async () => ({ ok: true }));
  });

  afterEach(async () => {
    await setMaintenanceMode(false);
    await app.close();
  });

  it("1. allows requests normally when maintenance is off", async () => {
    expect(isMaintenanceMode()).toBe(false);

    const v1Res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "test" },
    });
    expect(v1Res.statusCode).toBe(200);

    const userRes = await app.inject({
      method: "POST",
      url: "/api/users",
      payload: { username: "alice" },
    });
    expect(userRes.statusCode).toBe(200);
  });

  it("2. returns 503 + Retry-After on /v1 and /v0 when maintenance is active", async () => {
    await setMaintenanceMode(true, { drain: false });
    expect(isMaintenanceMode()).toBe(true);

    // /v1/*
    const v1Res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "test" },
    });
    expect(v1Res.statusCode).toBe(503);
    expect(v1Res.headers["retry-after"]).toBe("30");
    const v1Body = JSON.parse(v1Res.payload);
    expect(v1Body.error.code).toBe(ERR_MAINTENANCE_ACTIVE);

    // /v0/*
    const v0Res = await app.inject({
      method: "POST",
      url: "/v0/models",
      payload: {},
    });
    expect(v0Res.statusCode).toBe(503);
    expect(v0Res.headers["retry-after"]).toBe("30");
  });

  it("3. blocks admin mutating requests but permits database migration APIs during maintenance", async () => {
    await setMaintenanceMode(true, { drain: false });

    // Mutating business request blocked
    const userRes = await app.inject({
      method: "POST",
      url: "/api/users",
      payload: { username: "bob" },
    });
    expect(userRes.statusCode).toBe(503);

    // Migration and database settings allowed
    const dbGet = await app.inject({
      method: "GET",
      url: "/api/settings/database",
    });
    expect(dbGet.statusCode).toBe(200);

    const dbPost = await app.inject({
      method: "POST",
      url: "/api/settings/database/test",
      payload: {},
    });
    expect(dbPost.statusCode).toBe(200);
  });

  it("4. recovers completely when maintenance mode is deactivated", async () => {
    await setMaintenanceMode(true, { drain: false });
    expect(isMaintenanceMode()).toBe(true);

    await setMaintenanceMode(false);
    expect(isMaintenanceMode()).toBe(false);

    const v1Res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "test" },
    });
    expect(v1Res.statusCode).toBe(200);

    const userRes = await app.inject({
      method: "POST",
      url: "/api/users",
      payload: { username: "charlie" },
    });
    expect(userRes.statusCode).toBe(200);
  });

  it("5. drainRequests waits until inFlight reaches zero", async () => {
    incrementInFlight();
    expect(getInFlightCount()).toBeGreaterThan(0);

    // Decrement in background after 100ms
    setTimeout(() => {
      decrementInFlight();
    }, 100);

    await drainRequests(2000);
    expect(getInFlightCount()).toBe(0);
  });
});
