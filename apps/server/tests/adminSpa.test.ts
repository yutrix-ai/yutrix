import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import {
  isAdminSpaFallbackPath,
  shouldServeAdminSpa,
} from "../src/utils/adminSpa";
import { registerAdminSpaServing } from "../src/utils/adminSpaServing";

describe("shouldServeAdminSpa (unit)", () => {
  it("denies SPA on a configured route host even when adminHost is empty", () => {
    expect(
      shouldServeAdminSpa({
        hostname: "code.brtel.link",
        adminHost: "",
        routeHostnames: ["code.brtel.link", "api.brtel.link"],
      }),
    ).toBe(false);
  });

  it("denies SPA on a stored route host that is disabled (still in the list)", () => {
    expect(
      shouldServeAdminSpa({
        hostname: "CODE.BRTEL.LINK",
        adminHost: null,
        routeHostnames: ["code.brtel.link"],
      }),
    ).toBe(false);
  });

  it("allows SPA on a non-route host when adminHost is empty/unset", () => {
    expect(
      shouldServeAdminSpa({
        hostname: "token.brtel.link",
        adminHost: "",
        routeHostnames: ["code.brtel.link"],
      }),
    ).toBe(true);
    expect(
      shouldServeAdminSpa({
        hostname: "token.brtel.link",
        adminHost: "   ",
        routeHostnames: ["code.brtel.link"],
      }),
    ).toBe(true);
    expect(
      shouldServeAdminSpa({
        hostname: "127.0.0.1",
        adminHost: undefined,
        routeHostnames: [],
      }),
    ).toBe(true);
  });

  it("when adminHost is set, only that host gets SPA", () => {
    const routes = ["code.brtel.link"];
    expect(
      shouldServeAdminSpa({
        hostname: "token.brtel.link",
        adminHost: "token.brtel.link",
        routeHostnames: routes,
      }),
    ).toBe(true);
    expect(
      shouldServeAdminSpa({
        hostname: "TOKEN.BRTEL.LINK",
        adminHost: "token.brtel.link",
        routeHostnames: routes,
      }),
    ).toBe(true);
    expect(
      shouldServeAdminSpa({
        hostname: "other.brtel.link",
        adminHost: "token.brtel.link",
        routeHostnames: routes,
      }),
    ).toBe(false);
  });

  it("route host wins even if adminHost is misconfigured equal", () => {
    expect(
      shouldServeAdminSpa({
        hostname: "code.brtel.link",
        adminHost: "code.brtel.link",
        routeHostnames: ["code.brtel.link"],
      }),
    ).toBe(false);
  });

  it("treats hostname:port as the hostname for comparison", () => {
    expect(
      shouldServeAdminSpa({
        hostname: "token.brtel.link:443",
        adminHost: "token.brtel.link",
        routeHostnames: ["code.brtel.link"],
      }),
    ).toBe(true);
  });
});

describe("isAdminSpaFallbackPath", () => {
  it("excludes /api/, /v1/, and /v0/", () => {
    expect(isAdminSpaFallbackPath("/login")).toBe(true);
    expect(isAdminSpaFallbackPath("/")).toBe(true);
    expect(isAdminSpaFallbackPath("/v1/chat/completions")).toBe(false);
    expect(isAdminSpaFallbackPath("/v0/messages?x=1")).toBe(false);
    expect(isAdminSpaFallbackPath("/api/health")).toBe(false);
  });
});

describe("admin SPA host gate (integration)", () => {
  const dbFile = "data/promptgate-test-admin-spa.sqlite";
  const spaMarker = "ADMIN_SPA_SHELL_MARKER";
  let spaRoot = "";
  let db: any;
  let client: any;
  let systemSettings: any;
  let subdomains: any;
  let users: any;
  let app: FastifyInstance;
  let savedDbFile: string | undefined;

  async function mountApp() {
    if (app) await app.close();
    app = Fastify({ logger: false });
    registerAdminSpaServing(app, { root: spaRoot });
    await app.ready();
  }

  async function upsertSetting(key: string, value: string) {
    const existing = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, key));
    if (existing.length > 0) {
      await db
        .update(systemSettings)
        .set({ value, updatedAt: new Date() })
        .where(eq(systemSettings.key, key));
    } else {
      await db.insert(systemSettings).values({
        key,
        value,
        description: "",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }

  beforeAll(async () => {
    savedDbFile = process.env.DB_FILE;
    spaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yutrix-admin-spa-"));
    fs.writeFileSync(
      path.join(spaRoot, "index.html"),
      `<!doctype html><html><body>${spaMarker}</body></html>`,
    );

    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));
    ({ systemSettings, subdomains, users } = await import("../src/db/schema"));

    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: "spa-gate-admin",
      passwordHash: "dummy",
      role: "admin",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(subdomains).values({
      id: crypto.randomUUID(),
      userId,
      name: "code",
      hostname: "code.brtel.link",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(subdomains).values({
      id: crypto.randomUUID(),
      userId,
      name: "disabled-route",
      hostname: "old.brtel.link",
      enabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await mountApp();
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeAndCleanup(client, dbFile);
    if (savedDbFile !== undefined) process.env.DB_FILE = savedDbFile;
    else delete process.env.DB_FILE;
    if (spaRoot && fs.existsSync(spaRoot)) {
      fs.rmSync(spaRoot, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    await db.delete(systemSettings).where(eq(systemSettings.key, "adminHost"));
  });

  it("route host + GET / → JSON 404, not index.html", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "code.brtel.link" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.json()).toEqual({ error: "Not found" });
    expect(res.body).not.toContain(spaMarker);
  });

  it("disabled stored route host still does not get SPA", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/login",
      headers: { host: "old.brtel.link" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Not found" });
  });

  it("non-route host + empty adminHost → SPA allowed", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "token.brtel.link" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(spaMarker);
  });

  it("adminHost set → only that host gets SPA", async () => {
    await upsertSetting("adminHost", "token.brtel.link");

    const allowed = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "TOKEN.brtel.link" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toContain(spaMarker);

    const denied = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "other.brtel.link" },
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual({ error: "Not found" });
    expect(denied.body).not.toContain(spaMarker);
  });

  it("unknown /v1/... and /v0/... stay JSON 404, never SPA", async () => {
    const v1 = await app.inject({
      method: "GET",
      url: "/v1/does-not-exist",
      headers: { host: "token.brtel.link" },
    });
    expect(v1.statusCode).toBe(404);
    expect(v1.json()).toEqual({ error: "Not found" });
    expect(v1.body).not.toContain(spaMarker);

    const v0 = await app.inject({
      method: "POST",
      url: "/v0/unknown",
      headers: { host: "token.brtel.link" },
    });
    expect(v0.statusCode).toBe(404);
    expect(v0.json()).toEqual({ error: "Not found" });
    expect(v0.body).not.toContain(spaMarker);
  });

  it("GET /index.html on a route host is JSON 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/index.html",
      headers: { host: "code.brtel.link" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Not found" });
  });
});
