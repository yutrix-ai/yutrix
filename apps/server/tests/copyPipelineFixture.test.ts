import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as bcrypt from "bcryptjs";
import { Pool } from "pg";
import { initDb, closeDb, db } from "../src/db";
import { runCopyPipeline } from "../src/db/copy/pipeline";
import { isFreshInstall } from "../src/services/setup";
import {
  users,
  systemSettings,
  providers,
  providerApiKeys,
  endpoints,
  endpointRoutes,
  requestLogs,
  chatLogs,
} from "../src/db/schema";
import { eq } from "drizzle-orm";

const PG_TEST_URL =
  process.env.DATABASE_URL ||
  "postgres://yutrix:yutrix_test_pass@127.0.0.1:5432/yutrix";

const testDir = path.resolve(process.cwd(), "tests/tmp_copy_fixture_" + crypto.randomUUID());
const testSqliteFile = path.join(testDir, "fixture.sqlite");

describe("Slice P1: SQLite -> PostgreSQL Copy Pipeline Fixture Tests", () => {
  let pgPool: Pool;
  let isPgAvailable = false;

  beforeAll(async () => {
    fs.mkdirSync(testDir, { recursive: true });

    // Check PostgreSQL connection
    pgPool = new Pool({ connectionString: PG_TEST_URL, connectionTimeoutMillis: 3000 });
    try {
      await pgPool.query("SELECT 1 as val;");
      isPgAvailable = true;
      // Clean target Postgres schema
      await pgPool.query(
        "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;"
      );
    } catch (err: any) {
      console.warn(`[CopyFixtureTest] Postgres not accessible at ${PG_TEST_URL}. Skipping PG tests. Error:`, err.message);
      isPgAvailable = false;
    }

    // Initialize SQLite Fixture Database
    process.env.DB_FILE = testSqliteFile;
    delete process.env.DB_DRIVER;
    delete process.env.DATABASE_URL;

    await initDb({
      version: 1,
      driver: "sqlite",
      sqlite: { file: testSqliteFile },
      postgres: { url: "" },
      setupCompletedAt: "2026-09-01T00:00:00.000Z",
    });

    const { migrateSqlite } = await import("../src/db/migrate-sqlite");
    await migrateSqlite(db as any);
    const { ensureSqliteUpgraded } = await import("../src/db/copy/pipeline");
    await ensureSqliteUpgraded();

    // 1. Populate users
    const adminPasswordHash = await bcrypt.hash("AdminSecretPass123", 10);
    const alicePasswordHash = await bcrypt.hash("AliceSecretPass456", 10);

    await (db as any).insert(users).values([
      {
        id: "user-admin-1",
        username: "admin",
        passwordHash: adminPasswordHash,
        role: "admin",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "user-alice-2",
        username: "alice",
        passwordHash: alicePasswordHash,
        role: "user",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    // 2. Populate systemSettings (including temporary maintenance key)
    await (db as any).insert(systemSettings).values([
      {
        key: "mainDomain",
        value: "api.promptgate.ai",
        description: "Main access domain",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        key: "siteTitle",
        value: "PromptGate Enterprise",
        description: "Site title",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        key: "maintenance",
        value: "true",
        description: "Temporary migration maintenance flag",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    // 3. Populate providers and provider_api_keys
    await (db as any).insert(providers).values({
      id: "prov-openai-1",
      name: "OpenAI Official",
      openaiBaseUrl: "https://api.openai.com/v1",
      enabled: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const encryptedKey = "v1:enc:7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e";
    await (db as any).insert(providerApiKeys).values({
      id: "key-openai-1",
      providerId: "prov-openai-1",
      keyEncrypted: encryptedKey,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 4. Populate endpoints and endpoint_routes
    await (db as any).insert(endpoints).values({
      id: "ep-global-1",
      userId: "user-admin-1",
      name: "Default Route",
      path: "/chat",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await (db as any).insert(endpointRoutes).values({
      id: "route-gpt4o-1",
      endpointId: "ep-global-1",
      providerId: "prov-openai-1",
      modelId: "gpt-4o",
      enabled: 1,
      priority: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 5. Populate request_logs
    await (db as any).insert(requestLogs).values([
      {
        id: "req-log-1",
        requestId: "req-id-uuid-1",
        userId: "user-admin-1",
        endpointId: "ep-global-1",
        providerId: "prov-openai-1",
        model: "gpt-4o",
        statusCode: 200,
        inputTokens: 15,
        outputTokens: 30,
        totalTokens: 45,
        latencyMs: 320,
        createdAt: new Date(),
      },
      {
        id: "req-log-2",
        requestId: "req-id-uuid-2",
        userId: "user-alice-2",
        endpointId: "ep-global-1",
        providerId: "prov-openai-1",
        model: "gpt-4o-mini",
        statusCode: 200,
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        latencyMs: 180,
        createdAt: new Date(),
      },
    ]);

    // 6. Populate chat_logs
    await (db as any).insert(chatLogs).values([
      {
        id: "chat-log-1",
        requestId: "req-id-uuid-1",
        userId: "user-admin-1",
        model: "gpt-4o",
        inputText: "Hello Yutrix! How are you?",
        outputText: "Hello! I am doing great, ready to route your requests.",
        createdAt: new Date(),
      },
      {
        id: "chat-log-2",
        requestId: "req-id-uuid-2",
        userId: "user-alice-2",
        model: "gpt-4o-mini",
        inputText: "Tell me a joke.",
        outputText: "Why did the database administrator break up? Too many relationships.",
        createdAt: new Date(),
      },
    ]);
  });

  afterAll(async () => {
    await closeDb();
    if (pgPool) {
      try {
        await pgPool.end();
      } catch {
        // Ignore
      }
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("1. runs SQLite -> PostgreSQL copy pipeline, copying all tables and verifying data", async () => {
    if (!isPgAvailable) {
      console.warn("Skipping pipeline execution because PostgreSQL is not reachable.");
      return;
    }

    const initialSqliteSize = fs.statSync(testSqliteFile).size;
    expect(initialSqliteSize).toBeGreaterThan(0);

    // Execute copy pipeline
    const result = await runCopyPipeline({
      targetPgUrl: PG_TEST_URL,
      batchSize: 500,
      skipConfigWrite: true, // Keep isolated from app's real config file
    });

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.copiedRows).toBeGreaterThan(0);

    // 2. Verify in PostgreSQL:
    // A. Users
    const pgUsers = await pgPool.query('SELECT * FROM "users" ORDER BY "username" ASC;');
    expect(pgUsers.rows.length).toBe(2);
    expect(pgUsers.rows[0].username).toBe("admin");
    expect(pgUsers.rows[1].username).toBe("alice");
    // Verify bcrypt password hashes match
    const adminPassMatch = await bcrypt.compare("AdminSecretPass123", pgUsers.rows[0].passwordHash);
    expect(adminPassMatch).toBe(true);

    // B. System Settings: maintenance key MUST NOT be copied per PRD §9.2
    const pgSettings = await pgPool.query('SELECT * FROM "system_settings";');
    const settingsMap = Object.fromEntries(pgSettings.rows.map((r) => [r.key, r.value]));
    expect(settingsMap["mainDomain"]).toBe("api.promptgate.ai");
    expect(settingsMap["siteTitle"]).toBe("PromptGate Enterprise");
    expect(settingsMap["maintenance"]).toBeUndefined(); // Skipped as intended!

    // C. Providers: boolean enabled
    const pgProviders = await pgPool.query('SELECT * FROM "providers" WHERE "id" = $1;', ["prov-openai-1"]);
    expect(pgProviders.rows.length).toBe(1);
    expect(pgProviders.rows[0].name).toBe("OpenAI Official");
    expect(pgProviders.rows[0].enabled).toBe(true); // Native boolean in Postgres

    // D. Provider API Keys: raw ciphertext exact match
    const pgKeys = await pgPool.query('SELECT * FROM "provider_api_keys" WHERE "id" = $1;', ["key-openai-1"]);
    expect(pgKeys.rows.length).toBe(1);
    expect(pgKeys.rows[0].keyEncrypted).toBe("v1:enc:7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e");

    // E. Endpoint Routes
    const pgRoutes = await pgPool.query('SELECT * FROM "endpoint_routes" WHERE "id" = $1;', ["route-gpt4o-1"]);
    expect(pgRoutes.rows.length).toBe(1);
    expect(pgRoutes.rows[0].modelId).toBe("gpt-4o");
    expect(pgRoutes.rows[0].enabled).toBe(true);

    // F. Request Logs & Chat Logs text match
    const pgLogs = await pgPool.query('SELECT * FROM "chat_logs" ORDER BY "id" ASC;');
    expect(pgLogs.rows.length).toBe(2);
    expect(pgLogs.rows[0].inputText).toBe("Hello Yutrix! How are you?");
    expect(pgLogs.rows[0].outputText).toContain("ready to route your requests");
    expect(pgLogs.rows[1].inputText).toBe("Tell me a joke.");
    expect(pgLogs.rows[1].outputText).toContain("Too many relationships");

    // 3. Source SQLite file is untouched and preserved
    expect(fs.existsSync(testSqliteFile)).toBe(true);
    const postSqliteSize = fs.statSync(testSqliteFile).size;
    expect(postSqliteSize).toBe(initialSqliteSize);

    // 4. Seamless upgrade guarantee: isFreshInstall on original SQLite is false
    const fresh = await isFreshInstall();
    expect(fresh).toBe(false);
  });
});
