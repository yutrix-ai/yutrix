import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import cookie from "@fastify/cookie";
import { requireAuth, requireAdmin } from "../src/middleware/auth";
import { PassThrough } from "stream";

describe("SSE Authentication & Bearer Header Validation", () => {
  let fastify: FastifyInstance;
  const secret = "test-jwt-secret-key-1234567890123456";
  let userToken: string;
  let adminToken: string;

  beforeAll(async () => {
    fastify = Fastify();
    await fastify.register(cookie);
    await fastify.register(jwt, {
      secret,
      cookie: {
        cookieName: "token",
        signed: false,
      },
    });

    // Mock SSE endpoints mirroring /api/events/stream, /api/admin/logs/stream, /api/admin/chat-logs/stream
    fastify.get(
      "/api/events/stream",
      { onRequest: [requireAuth] },
      async (_req, reply) => {
        const stream = new PassThrough();
        reply.raw.setHeader("Content-Type", "text/event-stream");
        reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
        reply.raw.setHeader("Connection", "keep-alive");
        reply.raw.flushHeaders?.();
        stream.write("event: connected\ndata: {\"ok\":true}\n\n");
        setTimeout(() => stream.end(), 10);
        return reply.send(stream);
      }
    );

    fastify.get(
      "/api/admin/logs/stream",
      { onRequest: [requireAdmin] },
      async (_req, reply) => {
        const stream = new PassThrough();
        reply.header("Content-Type", "text/event-stream");
        reply.header("Cache-Control", "no-cache, no-transform");
        stream.write("event: connected\ndata: {\"ok\":true}\n\n");
        setTimeout(() => stream.end(), 10);
        return reply.send(stream);
      }
    );

    fastify.get(
      "/api/admin/chat-logs/stream",
      { onRequest: [requireAdmin] },
      async (_req, reply) => {
        const stream = new PassThrough();
        reply.header("Content-Type", "text/event-stream");
        reply.header("Cache-Control", "no-cache, no-transform");
        stream.write("event: connected\ndata: {\"ok\":true}\n\n");
        setTimeout(() => stream.end(), 10);
        return reply.send(stream);
      }
    );

    await fastify.ready();

    userToken = fastify.jwt.sign({ id: "user-1", username: "testuser", role: "user" });
    adminToken = fastify.jwt.sign({ id: "admin-1", username: "testadmin", role: "admin" });
  });

  afterAll(async () => {
    await fastify.close();
  });

  describe("Simulating reverse proxy dropping cookies (no cookie present)", () => {
    it("should return 401 for /api/events/stream when no Authorization Bearer is sent", async () => {
      const res = await fastify.inject({
        method: "GET",
        url: "/api/events/stream",
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: "未授权访问" });
    });

    it("should return 401 for /api/admin/logs/stream when no Authorization Bearer is sent", async () => {
      const res = await fastify.inject({
        method: "GET",
        url: "/api/admin/logs/stream",
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: "未授权访问" });
    });

    it("should return 401 for /api/admin/chat-logs/stream when no Authorization Bearer is sent", async () => {
      const res = await fastify.inject({
        method: "GET",
        url: "/api/admin/chat-logs/stream",
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: "未授权访问" });
    });

    it("should return 401 when invalid Bearer token is sent", async () => {
      const res = await fastify.inject({
        method: "GET",
        url: "/api/events/stream",
        headers: {
          authorization: "Bearer invalid-token",
        },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("Authenticated SSE streaming via Authorization: Bearer", () => {
    it("should succeed for /api/events/stream with valid user Bearer token", async () => {
      const res = await fastify.inject({
        method: "GET",
        url: "/api/events/stream",
        headers: {
          authorization: `Bearer ${userToken}`,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.body).toContain("event: connected");
    });

    it("should return 403 for /api/admin/logs/stream with non-admin user Bearer token", async () => {
      const res = await fastify.inject({
        method: "GET",
        url: "/api/admin/logs/stream",
        headers: {
          authorization: `Bearer ${userToken}`,
        },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "权限不足" });
    });

    it("should succeed for /api/admin/logs/stream with admin Bearer token", async () => {
      const res = await fastify.inject({
        method: "GET",
        url: "/api/admin/logs/stream",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.body).toContain("event: connected");
    });

    it("should succeed for /api/admin/chat-logs/stream with admin Bearer token", async () => {
      const res = await fastify.inject({
        method: "GET",
        url: "/api/admin/chat-logs/stream",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.body).toContain("event: connected");
    });
  });
});
