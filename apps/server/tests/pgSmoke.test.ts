import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDb, closeDb, db, client, getDbDriver } from "../src/db";
import { systemSettings } from "../src/db/schema.pg";
import { eq, sql } from "drizzle-orm";
import { nowExpr, dateBucket, fromUnix, jsonExtract, ident } from "../src/db/dialect";
import { Pool } from "pg";

const PG_URL =
  process.env.DATABASE_URL || "postgres://yutrix:yutrix_test_pass@127.0.0.1:5432/yutrix";

describe("Slice P0-3: PostgreSQL Migration & Driver Smoke Tests", () => {
  let isPgAvailable = false;

  beforeAll(async () => {
    try {
      const probePool = new Pool({
        connectionString: PG_URL,
        connectionTimeoutMillis: 1500,
      });
      await probePool.query("SELECT 1;");
      await probePool.end();
      isPgAvailable = true;
    } catch {
      console.warn("PostgreSQL not reachable at", PG_URL, "- skipping PG smoke tests.");
      isPgAvailable = false;
    }
  });

  afterAll(async () => {
    await closeDb();
    delete process.env.DB_DRIVER;
    delete process.env.DATABASE_URL;
    // Restore clean default SQLite state
    await initDb();
  });

  it("1. connects to PostgreSQL, runs migrations, and verifies active driver", async (ctx) => {
    if (!isPgAvailable) {
      ctx.skip();
      return;
    }

    await initDb({
      version: 1,
      driver: "postgres",
      sqlite: { file: "data/promptgate.sqlite" },
      postgres: { url: PG_URL },
      setupCompletedAt: null,
    });

    expect(getDbDriver()).toBe("postgres");
  });

  it("2. executes raw query SELECT 1 and verifies client proxy", async (ctx) => {
    if (!isPgAvailable) {
      ctx.skip();
      return;
    }

    const queryRes = await client.query("SELECT 1 as val;");
    expect(queryRes.rows[0].val).toBe(1);

    const executeRes = await client.execute("SELECT 2 as val;");
    expect(executeRes.rows[0].val).toBe(2);
  });

  it("3. lists migrated tables and confirms schema symmetry in database", async (ctx) => {
    if (!isPgAvailable) {
      ctx.skip();
      return;
    }

    const res = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    const tableNames = res.rows.map((r: any) => r.table_name);
    expect(tableNames).toContain("users");
    expect(tableNames).toContain("api_keys");
    expect(tableNames).toContain("chat_logs");
    expect(tableNames).toContain("endpoint_routes");
    expect(tableNames).toContain("system_settings");
    expect(tableNames.length).toBeGreaterThanOrEqual(28);
  });

  it("4. reads and writes using Drizzle schema.pg tables", async (ctx) => {
    if (!isPgAvailable) {
      ctx.skip();
      return;
    }

    const testKey = "pg_smoke_test_setting";
    const testValue = "active_" + Date.now();

    await db
      .insert(systemSettings)
      .values({
        key: testKey,
        value: testValue,
        description: "Smoke test setting",
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: testValue, updatedAt: Math.floor(Date.now() / 1000) },
      });

    const rows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, testKey));

    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe(testKey);
    expect(rows[0].value).toBe(testValue);

    // Cleanup
    await db.delete(systemSettings).where(eq(systemSettings.key, testKey));
  });

  it("5. validates dialect.ts helpers on PostgreSQL", async (ctx) => {
    if (!isPgAvailable) {
      ctx.skip();
      return;
    }

    // nowExpr
    const nowRes = await client.query(
      `SELECT extract(epoch from now())::bigint as now_ts;`
    );
    expect(Number(nowRes.rows[0].now_ts)).toBeGreaterThan(0);

    // dateBucket
    const bucketSql = dateBucket(Math.floor(Date.now() / 1000), "postgres");
    const bucketRes = await (db as any).execute(sql`SELECT ${bucketSql} as bucket;`);
    const bucketStr = bucketRes.rows[0].bucket;
    expect(bucketStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // jsonExtract
    const jsonExtractSql = jsonExtract(
      sql`'{"foo": "bar"}'`,
      "$.foo",
      "postgres"
    );
    const jsonRes = await (db as any).execute(sql`SELECT ${jsonExtractSql} as extracted;`);
    expect(jsonRes.rows[0].extracted).toBe("bar");

    // ident
    const identSql = ident("users", "postgres");
    const identRes = await (db as any).execute(sql`SELECT count(*) as count FROM ${identSql};`);
    expect(identRes.rows).toBeDefined();
  });
});
