import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import cookie from "@fastify/cookie";

const getProxy = vi.fn(async () => "http://proxy.local:8080");
const setProxy = vi.fn(async (value: string) => value);
const getStatus = vi.fn(async () => ({
  ready: true,
  running: false,
  version: "1.18.2",
  arch: "x64",
  lastError: null,
  streaming: "session-json-then-fake-sse",
}));

vi.mock("../src/opencode/settings", () => ({
  getOpencodeDownloadProxy: (...args: unknown[]) => getProxy(...args),
  setOpencodeDownloadProxy: (...args: unknown[]) => setProxy(...args),
}));

vi.mock("../src/opencode/opencodeService", () => ({
  OpencodeService: {
    getInstance: () => ({
      getStatus,
      start: vi.fn(),
      stop: vi.fn(),
      download: vi.fn(),
    }),
  },
}));

describe("admin OpenCode routes require admin auth + richer status", () => {
  let fastify: FastifyInstance;
  let userToken: string;
  let adminToken: string;

  beforeAll(async () => {
    const { opencodeRoutes } = await import("../src/opencode/index");
    fastify = Fastify();
    await fastify.register(cookie);
    await fastify.register(jwt, { secret: "test-jwt-secret-key-1234567890123456" });
    await fastify.register(opencodeRoutes);
    await fastify.ready();
    userToken = fastify.jwt.sign({ id: "u1", username: "user", role: "user" });
    adminToken = fastify.jwt.sign({ id: "a1", username: "admin", role: "admin" });
  });

  afterAll(async () => {
    await fastify.close();
  });

  it("returns 401 without a token and 403 for non-admin", async () => {
    const anon = await fastify.inject({ method: "GET", url: "/api/admin/opencode/status" });
    expect(anon.statusCode).toBe(401);
    const user = await fastify.inject({
      method: "GET",
      url: "/api/admin/opencode/status",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(user.statusCode).toBe(403);
  });

  it("returns ready/running/version/arch/lastError/proxyUrl for admin", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/admin/opencode/status",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    expect(body.running).toBe(false);
    expect(body.version).toBe("1.18.2");
    expect(body.arch).toBe("x64");
    expect(body.lastError).toBeNull();
    expect(body.proxyUrl).toBe("http://proxy.local:8080");
    expect(body).not.toHaveProperty("url");
    expect(body).not.toHaveProperty("serveUrl");
  });

  it("saves download proxy via admin settings", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/admin/opencode/settings",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      payload: { proxyUrl: "https://proxy.example:3128" },
    });
    expect(res.statusCode).toBe(200);
    expect(setProxy).toHaveBeenCalledWith("https://proxy.example:3128");
  });
});
