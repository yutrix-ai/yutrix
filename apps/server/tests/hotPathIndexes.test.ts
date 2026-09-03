import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import {
  ensureHotPathIndexes,
  ensureAnalyticsIndexes,
  HOT_PATH_INDEXES,
  ANALYTICS_INDEXES,
  applyIndexSpec,
} from "../src/startup/migrations";
import { resolveDbFilePath } from "../src/db/path";

const testDb = `data/test_hot_path_indexes_${crypto.randomUUID()}.sqlite`;
process.env.DB_FILE = testDb;

describe("Hot-Path DB Indexes Sweep", () => {
  let db: any;
  let client: any;

  beforeAll(async () => {
    const dbModule = await import("../src/db");
    await dbModule.initDb();
    db = dbModule.db;
    client = dbModule.client;

    const migrationsFolder = path.resolve(
      process.cwd(),
      process.cwd().endsWith("server") ? "./drizzle" : "apps/server/drizzle",
    );
    await migrate(db, { migrationsFolder });

    const { bootstrap } = await import("../src/bootstrap");
    await bootstrap();
  }, 60000);

  afterAll(async () => {
    const { closeDb } = await import("../src/db");
    try {
      await closeDb();
    } catch {}
    const fullPath = resolveDbFilePath(testDb, process.cwd());
    for (const t of [fullPath, `${fullPath}-wal`, `${fullPath}-shm`]) {
      if (fs.existsSync(t)) {
        try {
          fs.unlinkSync(t);
        } catch {}
      }
    }
  });

  it("ensureHotPathIndexes runs idempotently without throwing", async () => {
    // Run once
    await expect(ensureHotPathIndexes()).resolves.not.toThrow();
    // Run second time (idempotency check)
    await expect(ensureHotPathIndexes()).resolves.not.toThrow();
  });

  it("ensureAnalyticsIndexes runs idempotently without throwing", async () => {
    await expect(ensureAnalyticsIndexes()).resolves.not.toThrow();
    await expect(ensureAnalyticsIndexes()).resolves.not.toThrow();
  });

  it("asserts critical hot-path indexes exist in sqlite_master", async () => {
    const res = await client.execute(
      "SELECT type, name, tbl_name FROM sqlite_master WHERE type = 'index'",
    );
    const indexNames = new Set((res.rows as any[]).map((r) => r.name || r[1]));

    // Critical list from P0 production safety requirements
    const criticalIndexes = [
      "idx_action_logs_createdat",
      "idx_api_keys_keyhash",
      "idx_api_keys_userid",
      "idx_api_keys_user_status",
      "idx_invite_codes_codehash",
      "idx_openapi_keys_keyhash",
      "idx_openapi_keys_userid",
      "idx_provider_api_keys_provider_status",
      "idx_provider_api_keys_providerid",
      "idx_endpoint_routes_endpointid",
      "idx_endpoint_routes_subdomainid",
      "idx_endpoint_routes_endpoint_status",
      "idx_route_authorizations_userid",
      "idx_route_authorizations_groupid",
      "idx_chat_logs_session_created",
      "idx_chat_logs_user_client_session",
      "idx_distillation_learned_records_jobid",
      "idx_distillation_proposals_jobid",
      "idx_distillation_signal_versions_is_active",
      "idx_response_cache_createdat",
      "idx_users_status",
      "idx_prompt_injection_records_conv_policy",
      "idx_prompt_injection_records_user_created",
      "unq_user_one_group",
    ];

    for (const name of criticalIndexes) {
      expect(indexNames.has(name), `Expected index '${name}' to exist in sqlite_master`).toBe(true);
    }
  });

  it("verifies index column composition on key tables", async () => {
    // Check api_keys.keyHash index
    const apiKeyInfo = await client.execute("PRAGMA index_info(idx_api_keys_keyhash)");
    const apiKeyCols = (apiKeyInfo.rows as any[]).map((r) => r.name || r[2]);
    expect(apiKeyCols).toEqual(["keyHash"]);

    // Check chat_logs(serverSessionId, createdAt) composite
    const sessionCreatedInfo = await client.execute("PRAGMA index_info(idx_chat_logs_session_created)");
    const sessionCreatedCols = (sessionCreatedInfo.rows as any[]).map((r) => r.name || r[2]);
    expect(sessionCreatedCols).toEqual(["serverSessionId", "createdAt"]);

    // Check chat_logs(userId, clientSessionId) composite
    const userClientSessionInfo = await client.execute("PRAGMA index_info(idx_chat_logs_user_client_session)");
    const userClientSessionCols = (userClientSessionInfo.rows as any[]).map((r) => r.name || r[2]);
    expect(userClientSessionCols).toEqual(["userId", "clientSessionId"]);

    // Check endpoint_routes(endpointId, status) composite
    const endpointStatusInfo = await client.execute("PRAGMA index_info(idx_endpoint_routes_endpoint_status)");
    const endpointStatusCols = (endpointStatusInfo.rows as any[]).map((r) => r.name || r[2]);
    expect(endpointStatusCols).toEqual(["endpointId", "status"]);

    // Check action_logs.createdAt
    const actionLogsInfo = await client.execute("PRAGMA index_info(idx_action_logs_createdat)");
    const actionLogsCols = (actionLogsInfo.rows as any[]).map((r) => r.name || r[2]);
    expect(actionLogsCols).toEqual(["createdAt"]);
  });

  it("skips gracefully when table does not exist", async () => {
    const spec = {
      table: "non_existent_table_xyz",
      name: "idx_fake_index",
      sqliteColumns: "someCol",
      pgColumns: '"someCol"',
    };
    await expect(applyIndexSpec(spec)).resolves.not.toThrow();
  });

  it("survives invalid SQL in index spec without crashing boot", async () => {
    const badSpec = {
      table: "users",
      name: "idx_invalid_sql_test",
      sqliteColumns: "non_existent_column_abc",
      pgColumns: '"non_existent_column_abc"',
    };
    // Should catch warning and NOT throw
    await expect(applyIndexSpec(badSpec)).resolves.not.toThrow();
  });

  it("Postgres dialect logic: handles concurrent failure by falling back to plain CREATE INDEX", async () => {
    const dbModule = await import("../src/db");
    const executedQueries: string[] = [];

    // Spy getDbDriver to return postgres
    const driverSpy = vi.spyOn(dbModule, "getDbDriver").mockReturnValue("postgres");

    const underlyingClient = dbModule.getClient();
    const originalExecute = underlyingClient.execute;
    underlyingClient.execute = async (arg: any) => {
      const sqlText = typeof arg === "string" ? arg : arg?.sql || "";
      executedQueries.push(sqlText);
      if (sqlText.includes("information_schema.tables")) {
        return { rows: [{ exists: 1 }] };
      }
      if (sqlText.includes("CONCURRENTLY")) {
        throw new Error("Cannot run CONCURRENTLY inside a transaction");
      }
      return { rows: [] };
    };

    try {
      const spec = {
        table: "action_logs",
        name: "idx_test_pg_concurrent",
        sqliteColumns: "createdAt",
        pgColumns: '"createdAt"',
      };
      await expect(applyIndexSpec(spec)).resolves.not.toThrow();

      // Assert CONCURRENTLY was attempted first
      expect(
        executedQueries.some((q) =>
          q.includes(
            'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_test_pg_concurrent ON "action_logs" ("createdAt")',
          ),
        ),
      ).toBe(true);

      // Assert fallback to plain CREATE INDEX was executed
      expect(
        executedQueries.some((q) =>
          q.includes(
            'CREATE INDEX IF NOT EXISTS idx_test_pg_concurrent ON "action_logs" ("createdAt")',
          ),
        ),
      ).toBe(true);
    } finally {
      underlyingClient.execute = originalExecute;
      driverSpy.mockRestore();
    }
  });
});
