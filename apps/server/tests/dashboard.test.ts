import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import fs from "fs";
import path from "path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq, sql } from "drizzle-orm";

const testDbPath = "data/promptgate_dashboard_test.sqlite";
process.env.DB_FILE = testDbPath;

let db: any;
let usersTable: any;
let requestLogsTable: any;
let dashboardRoutes: any;

const getResolvedDbPath = () => {
  if (process.cwd().endsWith("server")) {
    return path.join(process.cwd(), "../../", testDbPath);
  }
  return path.join(process.cwd(), testDbPath);
};

describe("Dashboard Endpoint", () => {
  const fastify = Fastify();

  beforeAll(async () => {
    // Delete existing test DB if any
    const resolvedPath = getResolvedDbPath();
    if (fs.existsSync(resolvedPath)) {
      try {
        fs.unlinkSync(resolvedPath);
      } catch (e) {}
    }
    if (fs.existsSync(resolvedPath + "-wal")) {
      try {
        fs.unlinkSync(resolvedPath + "-wal");
      } catch (e) {}
    }
    if (fs.existsSync(resolvedPath + "-shm")) {
      try {
        fs.unlinkSync(resolvedPath + "-shm");
      } catch (e) {}
    }

    ({ db } = await import("../src/db"));
    ({ users: usersTable, requestLogs: requestLogsTable } = await import("../src/db/schema"));
    dashboardRoutes = (await import("../src/routes/dashboard")).default;

    const migrationsFolder = path.resolve(
      process.cwd(),
      process.cwd().endsWith("server") ? "./drizzle" : "apps/server/drizzle",
    );
    await migrate(db, { migrationsFolder });

    // Register jwt
    await fastify.register(require("@fastify/jwt"), {
      secret: "testsecret",
    });

    // Mock requireAdmin check by overriding jwtVerify
    fastify.addHook("onRequest", async (request) => {
      request.jwtVerify = async () => {
        request.user = { role: "admin", id: "admin" };
      };
    });

    // Register dashboard routes
    fastify.register(dashboardRoutes);
    await fastify.ready();
  });

  afterAll(async () => {
    // Cleanup DB
    const resolvedPath = getResolvedDbPath();
    if (fs.existsSync(resolvedPath)) {
      try {
        fs.unlinkSync(resolvedPath);
      } catch (e) {}
    }
  });

  it("should return all active users in userRanking without capping at 8", async () => {
    const activeUsersCount = 10;
    const now = new Date();

    // Create 10 mock users and corresponding request logs
    for (let i = 1; i <= activeUsersCount; i++) {
      const userId = `user-id-${i}`;
      const username = `User-${i}`;

      await db.insert(usersTable).values({
        id: userId,
        username,
        passwordHash: "hash",
        role: "user",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(requestLogsTable).values({
        id: `log-id-${i}`,
        requestId: `req-id-${i}`,
        userId,
        inputTokens: 100 * i,
        outputTokens: 50 * i,
        totalTokens: 150 * i,
        createdAt: now,
      });
    }

    // Call the /api/admin/dashboard/token-usage endpoint
    const response = await fastify.inject({
      method: "GET",
      url: "/api/admin/dashboard/token-usage",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body).toHaveProperty("userRanking");
    // Assert that we get all 10 users instead of being limited to 8
    expect(body.userRanking.length).toBe(10);

    // Verify ordering is descending by totalTokens
    const rankings = body.userRanking;
    for (let i = 0; i < rankings.length - 1; i++) {
      expect(rankings[i].totalTokens).toBeGreaterThanOrEqual(rankings[i + 1].totalTokens);
    }
  });
});
