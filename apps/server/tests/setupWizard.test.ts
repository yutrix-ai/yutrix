import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as bcrypt from "bcryptjs";
import Fastify, { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import {
  isFreshInstall,
  hasUnattendedEnv,
  testDbConnection,
  completeSetup,
  performUnattendedSetup,
  getSetupPending,
  setSetupPending,
  resetSetupCompletedInMemory,
} from "../src/services/setup";
import setupRoutes from "../src/routes/setup";
import { initDb, closeDb, db, isDbInitialized } from "../src/db";
import { users, systemSettings } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { ERR_SETUP_REQUIRED, ERR_SETUP_REQUIRED_MESSAGE } from "@promptgate/shared";
import { getDbConfigPath } from "../src/db/config";

const testDir = path.resolve(process.cwd(), "tests/tmp_setup_" + crypto.randomUUID());
const testDbFile = path.join(testDir, "test.sqlite");
const testConfigFile = path.join(testDir, "yutrix.config.json");

describe("Slice P0-4: Setup Wizard & Unattended Env", () => {
  beforeEach(async () => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.DB_FILE = testDbFile;
    delete process.env.DB_DRIVER;
    delete process.env.DATABASE_URL;
    delete process.env.SETUP_FORCE;
    delete process.env.YUTRIX_ADMIN_USER;
    delete process.env.YUTRIX_ADMIN_PASSWORD;
    delete process.env.YUTRIX_MAIN_DOMAIN;
    delete process.env.PROMPTGATE_SECRET;
    resetSetupCompletedInMemory();
    setSetupPending(false);
    const configPath = getDbConfigPath();
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    await closeDb();
  });

  afterEach(async () => {
    await closeDb();
    delete process.env.DB_FILE;
    delete process.env.DB_DRIVER;
    delete process.env.DATABASE_URL;
    delete process.env.SETUP_FORCE;
    delete process.env.YUTRIX_ADMIN_USER;
    delete process.env.YUTRIX_ADMIN_PASSWORD;
    delete process.env.YUTRIX_MAIN_DOMAIN;
    delete process.env.PROMPTGATE_SECRET;
    resetSetupCompletedInMemory();
    setSetupPending(false);
    const configPath = getDbConfigPath();
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("1. isFreshInstall: returns true when DB file does not exist", async () => {
    if (fs.existsSync(testDbFile)) {
      fs.unlinkSync(testDbFile);
    }
    const fresh = await isFreshInstall();
    expect(fresh).toBe(true);
  });

  it("2. isFreshInstall: returns false when users exist in database", async () => {
    await initDb({
      version: 1,
      driver: "sqlite",
      sqlite: { file: testDbFile },
      postgres: { url: "" },
      setupCompletedAt: null,
    });

    const { migrateSqlite } = await import("../src/db/migrate-sqlite");
    await migrateSqlite(db as any);

    // Insert an admin user
    await (db as any).insert(users).values({
      id: crypto.randomUUID(),
      username: "existing_admin",
      passwordHash: await bcrypt.hash("pass123", 10),
      role: "admin",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const fresh = await isFreshInstall();
    expect(fresh).toBe(false);
  });

  it("3. isFreshInstall: SETUP_FORCE=1 overrides and returns true even with users", async () => {
    await initDb({
      version: 1,
      driver: "sqlite",
      sqlite: { file: testDbFile },
      postgres: { url: "" },
      setupCompletedAt: null,
    });

    const { migrateSqlite } = await import("../src/db/migrate-sqlite");
    await migrateSqlite(db as any);

    await (db as any).insert(users).values({
      id: crypto.randomUUID(),
      username: "admin_override",
      passwordHash: "hash",
      role: "admin",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    process.env.SETUP_FORCE = "1";
    const fresh = await isFreshInstall();
    expect(fresh).toBe(true);
  });

  it("4. testDbConnection: tests sqlite and postgres drivers correctly", async () => {
    // SQLite: valid directory
    const sqliteOk = await testDbConnection({
      driver: "sqlite",
      sqliteFile: path.join(testDir, "db.sqlite"),
    });
    expect(sqliteOk.ok).toBe(true);

    // Postgres: missing URL
    const pgMissing = await testDbConnection({
      driver: "postgres",
      databaseUrl: "",
    });
    expect(pgMissing.ok).toBe(false);
    expect(pgMissing.error).toContain("URL is required");

    // Postgres: valid live URL test (against local PG test instance)
    const pgLive = await testDbConnection({
      driver: "postgres",
      databaseUrl: "postgres://yutrix:yutrix_test_pass@127.0.0.1:5432/yutrix",
    });
    expect(pgLive.ok).toBe(true);
  });

  it("5. completeSetup: initializes system, seeds admin with bcrypt, and writes config with 0600 mode", async () => {
    const configTargetPath = getDbConfigPath();
    // Ensure clean state before setup
    if (fs.existsSync(configTargetPath)) {
      fs.unlinkSync(configTargetPath);
    }

    const testPassword = "MySecureAdminPass123!";
    const result = await completeSetup({
      username: "setup_admin",
      password: testPassword,
      mainDomain: "gateway.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      driver: "sqlite",
      sqliteFile: testDbFile,
      siteTitle: "Custom Gateway",
    });

    expect(result.ok).toBe(true);
    expect(result.admin.username).toBe("setup_admin");
    expect(result.admin.role).toBe("admin");

    // Check that config file was written with 0600 permissions
    expect(fs.existsSync(configTargetPath)).toBe(true);
    const stat = fs.statSync(configTargetPath);
    expect(stat.mode & 0o777).toBe(0o600);

    const savedConfig = JSON.parse(fs.readFileSync(configTargetPath, "utf-8"));
    expect(savedConfig.setupCompletedAt).toBeDefined();
    expect(savedConfig.driver).toBe("sqlite");

    // Verify admin user in database
    const adminUser = await db
      .select()
      .from(users)
      .where(eq(users.username, "setup_admin"));
    expect(adminUser.length).toBe(1);
    expect(adminUser[0].role).toBe("admin");
    // Password was hashed with bcrypt
    const passwordMatch = await bcrypt.compare(testPassword, adminUser[0].passwordHash);
    expect(passwordMatch).toBe(true);

    // Verify mainDomain was saved in systemSettings
    const domainSetting = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, "mainDomain"));
    expect(domainSetting.length).toBe(1);
    expect(domainSetting[0].value).toBe("gateway.example.com");

    const adminHostSetting = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, "adminHost"));
    expect(adminHostSetting.length).toBe(0);

    // Subsequent call fails with 409 Conflict
    await expect(
      completeSetup({
        username: "setup_admin",
        password: "newpassword",
        mainDomain: "other.com",
        secret: "0123456789abcdef0123456789abcdef",
        driver: "sqlite",
      })
    ).rejects.toThrow(/already been completed/);

    // Clean up created config file so other tests are not affected
    if (fs.existsSync(configTargetPath)) {
      fs.unlinkSync(configTargetPath);
    }
  });

  it("6. unattended env: initializes system directly and skips wizard", async () => {
    const configTargetPath = getDbConfigPath();
    if (fs.existsSync(configTargetPath)) {
      fs.unlinkSync(configTargetPath);
    }

    process.env.YUTRIX_ADMIN_USER = "unattended_admin";
    process.env.YUTRIX_ADMIN_PASSWORD = "UnattendedSecretPass999";
    process.env.YUTRIX_MAIN_DOMAIN = "auto.example.com";
    process.env.PROMPTGATE_SECRET = "fedcba9876543210fedcba9876543210";
    process.env.DB_FILE = testDbFile;

    expect(hasUnattendedEnv()).toBe(true);

    await performUnattendedSetup();

    // Verify user created
    const created = await db
      .select()
      .from(users)
      .where(eq(users.username, "unattended_admin"));
    expect(created.length).toBe(1);

    const valid = await bcrypt.compare("UnattendedSecretPass999", created[0].passwordHash);
    expect(valid).toBe(true);

    if (fs.existsSync(configTargetPath)) {
      fs.unlinkSync(configTargetPath);
    }
  });

  it("7. seamless upgrade: existing sqlite DB without new env never enters setup and writes no config", async () => {
    const configTargetPath = getDbConfigPath();
    if (fs.existsSync(configTargetPath)) {
      fs.unlinkSync(configTargetPath);
    }

    // Set up existing DB with admin
    await initDb({
      version: 1,
      driver: "sqlite",
      sqlite: { file: testDbFile },
      postgres: { url: "" },
      setupCompletedAt: null,
    });
    const { migrateSqlite } = await import("../src/db/migrate-sqlite");
    await migrateSqlite(db as any);

    await (db as any).insert(users).values({
      id: crypto.randomUUID(),
      username: "legacy_admin",
      passwordHash: await bcrypt.hash("legacy_pass", 10),
      role: "admin",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const fresh = await isFreshInstall();
    expect(fresh).toBe(false);

    // No config file should be written for existing installs
    expect(fs.existsSync(configTargetPath)).toBe(false);
  });

  it("8. API routes and gating: redirects /login to /setup and rejects /v1 when setup pending", async () => {
    const app = Fastify();
    await app.register(cookie);
    await app.register(jwt, { secret: "test-secret-at-least-32-chars-long!" });

    // Simulate setup pending state
    setSetupPending(true);

    app.addHook("onRequest", async (request, reply) => {
      if (getSetupPending()) {
        const url = request.url.split("?")[0];
        if (url.startsWith("/api/setup") || url === "/setup" || url === "/api/health") {
          return;
        }
        if (url.startsWith("/v1/")) {
          return reply.code(503).send({
            error: {
              message: ERR_SETUP_REQUIRED_MESSAGE,
              type: "uninitialized_error",
              code: ERR_SETUP_REQUIRED,
            },
          });
        }
        if (url === "/login" || url.startsWith("/api/auth")) {
          return reply.code(307).redirect("/setup");
        }
      }
    });

    await app.register(setupRoutes);

    // 1. GET /api/setup/status
    const statusRes = await app.inject({
      method: "GET",
      url: "/api/setup/status",
    });
    expect(statusRes.statusCode).toBe(200);
    const statusData = JSON.parse(statusRes.payload);
    expect(statusData).toHaveProperty("fresh");
    expect(statusData).toHaveProperty("driver");

    // 2. Gateway /v1/* blocked with 503
    const v1Res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "gpt-4", messages: [] },
    });
    expect(v1Res.statusCode).toBe(503);
    const v1Data = JSON.parse(v1Res.payload);
    expect(v1Data.error.code).toBe(ERR_SETUP_REQUIRED);

    // 3. /login redirects with 307 to /setup
    const loginRes = await app.inject({
      method: "GET",
      url: "/login",
    });
    expect(loginRes.statusCode).toBe(307);
    expect(loginRes.headers.location).toBe("/setup");

    await app.close();
  });

  it("9. seedAdminUser never logs plaintext passwords or invite code secrets", async () => {
    await initDb({
      version: 1,
      driver: "sqlite",
      sqlite: { file: testDbFile },
    });
    const { migrateSqlite } = await import("../src/db/migrate-sqlite");
    await migrateSqlite(db as any);
    // Clear admin users in test db so seedAdminUser triggers
    await db.delete(users).where(eq(users.role, "admin"));

    const loggedMessages: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      loggedMessages.push(args.join(" "));
    });

    try {
      const { seedAdminUser } = await import("../src/startup/seed");
      await seedAdminUser();

      const combined = loggedMessages.join("\n");
      // Must not contain plaintext password or invite code
      expect(combined).not.toMatch(/管理员密码/);
      expect(combined).not.toMatch(/邀请码:/);
      expect(combined).not.toMatch(/pg-inv-[a-f0-9]{12}/);
      expect(combined).toContain("Admin user initialized");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("10. completeSetup persists optional adminHost when provided", async () => {
    const configTargetPath = getDbConfigPath();
    if (fs.existsSync(configTargetPath)) {
      fs.unlinkSync(configTargetPath);
    }

    const result = await completeSetup({
      username: "admin_host_setup",
      password: "MySecureAdminPass123!",
      mainDomain: "brtel.link",
      adminHost: "token.brtel.link",
      secret: "0123456789abcdef0123456789abcdef",
      driver: "sqlite",
      sqliteFile: testDbFile,
    });
    expect(result.ok).toBe(true);

    const adminHostSetting = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, "adminHost"));
    expect(adminHostSetting.length).toBe(1);
    expect(adminHostSetting[0].value).toBe("token.brtel.link");

    if (fs.existsSync(configTargetPath)) {
      fs.unlinkSync(configTargetPath);
    }
  });

  it("11. completeSetup enforces password minimum length of 8", async () => {
    // 7 characters must fail
    await expect(
      completeSetup({
        username: "admin_test",
        password: "1234567",
        mainDomain: "gateway.example.com",
        secret: "0123456789abcdef0123456789abcdef",
        driver: "sqlite",
      })
    ).rejects.toThrow(/at least 8 characters/);

    // Empty password must fail
    await expect(
      completeSetup({
        username: "admin_test",
        password: "",
        mainDomain: "gateway.example.com",
        secret: "0123456789abcdef0123456789abcdef",
        driver: "sqlite",
      })
    ).rejects.toThrow(/at least 8 characters/);
  });
});
