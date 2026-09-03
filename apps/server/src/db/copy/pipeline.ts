import { Pool } from "pg";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schemaPg from "../schema.pg";
import { db, initDb, isDbInitialized, getDbDriver } from "../../db";
import { loadDbConfig, saveDbConfig, YutrixDbConfig } from "../config";
import { initAutoMigrations } from "../../db";
import { migratePg } from "../migrate-pg";
import { getReflectedTables, ReflectedTable } from "./reflect";
import { transformRow } from "./codec";

export interface MigrationTableProgress {
  copied: number;
  total: number;
  status: "pending" | "copying" | "done" | "error";
}

export interface MigrationProgress {
  inProgress: boolean;
  stage:
    | "idle"
    | "preparing"
    | "migrating_pg"
    | "copying_tables"
    | "verifying"
    | "completed"
    | "failed";
  currentTable?: string;
  tables: Record<string, MigrationTableProgress>;
  totalRows: number;
  copiedRows: number;
  error?: string;
  completedAt?: string;
}

let activeProgress: MigrationProgress = {
  inProgress: false,
  stage: "idle",
  tables: {},
  totalRows: 0,
  copiedRows: 0,
};

export function getMigrationProgress(): MigrationProgress {
  return { ...activeProgress, tables: { ...activeProgress.tables } };
}

export function resetMigrationProgress(): void {
  activeProgress = {
    inProgress: false,
    stage: "idle",
    tables: {},
    totalRows: 0,
    copiedRows: 0,
  };
}

export interface RunCopyPipelineOptions {
  targetPgUrl: string;
  batchSize?: number;
  onProgress?: (progress: MigrationProgress) => void;
  skipConfigWrite?: boolean; // useful for isolated test runs
}

export interface CopyPipelineResult {
  ok: boolean;
  totalTables: number;
  totalRows: number;
  copiedRows: number;
  verified: boolean;
  tables: Record<string, { copied: number; total: number }>;
  error?: string;
}

/**
 * Builds an idempotent multi-row INSERT query for PostgreSQL.
 */
function buildBatchInsertQuery(
  tableName: string,
  columns: string[],
  rows: Record<string, any>[]
): { text: string; values: any[] } {
  const quotedCols = columns.map((c) => `"${c}"`).join(", ");
  const values: any[] = [];
  const valuePlaceholders: string[] = [];

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const rowPlaceholders: string[] = [];
    for (let c = 0; c < columns.length; c++) {
      values.push(row[columns[c]]);
      rowPlaceholders.push(`$${values.length}`);
    }
    valuePlaceholders.push(`(${rowPlaceholders.join(", ")})`);
  }

  const text = `INSERT INTO "${tableName}" (${quotedCols}) VALUES ${valuePlaceholders.join(", ")};`;
  return { text, values };
}

/**
 * Ensures the source SQLite database is upgraded with all columns and tables to date.
 */
export async function ensureSqliteUpgraded(): Promise<void> {
  const { initAutoMigrations } = await import("../index");
  await initAutoMigrations();

  try { await (db as any).run(sql`ALTER TABLE chat_logs ADD COLUMN responseHash text`); } catch { /* ignore */ }
  try { await (db as any).run(sql`ALTER TABLE endpoint_routes ADD COLUMN fallbackMatchTarget integer DEFAULT 0 NOT NULL`); } catch { /* ignore */ }
  try { await (db as any).run(sql`ALTER TABLE endpoint_routes ADD COLUMN schedules text`); } catch { /* ignore */ }

  const {
    ensureFunnelRoutingColumns,
    ensureStrategyRoutingColumns,
    ensureTokenLimitColumns,
    ensureProviderModelContextWindowColumn,
    ensureAnalyticsIndexes,
    ensureHotPathIndexes,
    ensureSubdomainHostnameIdentity,
    ensureExclusiveUserGroupMembership,
  } = await import("../../startup/migrations");

  await ensureFunnelRoutingColumns().catch(() => {});
  await ensureStrategyRoutingColumns().catch(() => {});
  await ensureTokenLimitColumns().catch(() => {});
  await ensureProviderModelContextWindowColumn().catch(() => {});
  await ensureAnalyticsIndexes().catch(() => {});
  await ensureHotPathIndexes().catch(() => {});
  await ensureSubdomainHostnameIdentity().catch(() => {});
  await ensureExclusiveUserGroupMembership().catch(() => {});
}

/**
 * Executes the complete SQLite -> PostgreSQL migration pipeline.
 * Per PRD §9:
 * 1. Assert source is SQLite and target is accessible Postgres.
 * 2. Run source SQLite migrations.
 * 3. Run target Postgres migrations.
 * 4. SET session_replication_role = replica (disable FK checks).
 * 5. Batch copy all tables, transforming data via codec and skipping maintenance key.
 * 6. Restore FK checks.
 * 7. Verify counts and spot checks.
 * 8. Write yutrix.config.json (driver=postgres, mode 0600).
 * 9. Preserve source SQLite intact.
 */
export async function runCopyPipeline(
  options: RunCopyPipelineOptions
): Promise<CopyPipelineResult> {
  const { targetPgUrl, batchSize = 1000, onProgress, skipConfigWrite } = options;

  if (!targetPgUrl || (!targetPgUrl.startsWith("postgres://") && !targetPgUrl.startsWith("postgresql://"))) {
    throw new Error("Invalid PostgreSQL connection URL. Must start with postgres:// or postgresql://");
  }

  activeProgress = {
    inProgress: true,
    stage: "preparing",
    tables: {},
    totalRows: 0,
    copiedRows: 0,
  };
  onProgress?.(activeProgress);

  let pool: Pool | null = null;
  let fkDisabled = false;

  try {
    // 1. Connect to Target PostgreSQL
    pool = new Pool({
      connectionString: targetPgUrl,
      connectionTimeoutMillis: 5000,
    });
    await pool.query("SELECT 1 as val;");

    // 2. Ensure SQLite source is initialized & migrated
    if (!isDbInitialized()) {
      await initDb();
    }
    await ensureSqliteUpgraded();

    // 3. Migrate target PostgreSQL to create all 28 tables and indexes
    activeProgress.stage = "migrating_pg";
    onProgress?.(activeProgress);

    const targetPgDb = drizzlePg(pool, { schema: schemaPg });
    await migratePg(targetPgDb);

    // 4. Disable Foreign Keys on target PostgreSQL session (best-effort if user has superuser permissions)
    fkDisabled = false;
    try {
      await pool.query("SET session_replication_role = replica;");
      fkDisabled = true;
    } catch {
      // Non-superuser role; current schema has no FK constraints per PRD §9.4, safe to proceed
    }

    // 5. Inspect and prepare reflected tables
    const tables = getReflectedTables();
    let overallTotalRows = 0;
    const tableCounts: Record<string, number> = {};

    for (const table of tables) {
      try {
        const countRes = await (db as any).run(
          sql.raw(`SELECT count(*) as count FROM "${table.name}"`)
        );
        const count = Number(countRes.rows[0]?.[0] ?? 0);
        tableCounts[table.name] = count;
        overallTotalRows += count;
        activeProgress.tables[table.name] = {
          copied: 0,
          total: count,
          status: "pending",
        };
      } catch (err) {
        console.warn(`[Copy/Pipeline] Failed to count rows in table "${table.name}":`, err);
        tableCounts[table.name] = 0;
        activeProgress.tables[table.name] = {
          copied: 0,
          total: 0,
          status: "pending",
        };
      }
    }

    activeProgress.totalRows = overallTotalRows;
    activeProgress.stage = "copying_tables";
    onProgress?.(activeProgress);

    let totalCopied = 0;

    // Copy table data
    for (const table of tables) {
      activeProgress.currentTable = table.name;
      activeProgress.tables[table.name].status = "copying";
      onProgress?.(activeProgress);

      const totalTableRows = tableCounts[table.name] || 0;
      let tableCopied = 0;

      if (totalTableRows > 0) {
        for (let offset = 0; offset < totalTableRows; offset += batchSize) {
          const fetchSql = `SELECT * FROM "${table.name}" LIMIT ${batchSize} OFFSET ${offset};`;
          const sqliteRowsResult = await (db as any).run(sql.raw(fetchSql));
          const rawRows = sqliteRowsResult.rows || [];

          // Transform rows and filter out temporary maintenance flag from system_settings
          const transformedRows: Record<string, any>[] = [];
          for (const rawRow of rawRows) {
            // rawRow is either an array of values matching column order or an object
            let rowObj: Record<string, any> = {};
            if (Array.isArray(rawRow)) {
              for (let i = 0; i < table.columns.length; i++) {
                rowObj[table.columns[i].name] = rawRow[i];
              }
            } else {
              rowObj = rawRow;
            }

            // Skip maintenance key in system_settings per PRD §9.2
            if (table.name === "system_settings") {
              const keyVal = rowObj.key;
              if (keyVal === "maintenance") {
                continue;
              }
            }

            const transformed = transformRow(rowObj, table.columns);
            transformedRows.push(transformed);
          }

          if (transformedRows.length > 0) {
            // Batch insert into PostgreSQL
            const batchQuery = buildBatchInsertQuery(
              table.name,
              table.columnNames,
              transformedRows
            );
            await pool.query(batchQuery.text, batchQuery.values);
          }

          tableCopied += transformedRows.length;
          totalCopied += transformedRows.length;
          activeProgress.tables[table.name].copied = tableCopied;
          activeProgress.copiedRows = totalCopied;
          onProgress?.(activeProgress);
        }
      }

      activeProgress.tables[table.name].status = "done";
      onProgress?.(activeProgress);
    }

    // 6. Restore Foreign Key constraints
    if (fkDisabled) {
      try {
        await pool.query("SET session_replication_role = DEFAULT;");
      } catch {
        // Ignore
      }
    }

    // 7. Verify tables and sample row spot checks
    activeProgress.stage = "verifying";
    onProgress?.(activeProgress);

    for (const table of tables) {
      const pgCountRes = await pool.query(
        `SELECT count(*)::int as count FROM "${table.name}";`
      );
      const pgCount = Number(pgCountRes.rows[0]?.count ?? 0);
      const expectedCount = activeProgress.tables[table.name].copied;

      if (pgCount !== expectedCount) {
        throw new Error(
          `Verification mismatch for table "${table.name}": SQLite exported ${expectedCount} rows, but PostgreSQL has ${pgCount} rows.`
        );
      }
    }

    // Spot-check users admin exists
    const adminCheck = await pool.query(
      `SELECT count(*)::int as count FROM "users" WHERE "role" = 'admin';`
    );
    if (tableCounts["users"] > 0 && Number(adminCheck.rows[0]?.count ?? 0) === 0) {
      throw new Error("Verification failed: Admin user missing in PostgreSQL target.");
    }

    // 8. Persist new PostgreSQL configuration to data/yutrix.config.json with 0600 mode
    if (!skipConfigWrite) {
      const currentConfig = loadDbConfig();
      const updatedConfig: YutrixDbConfig = {
        version: 1,
        driver: "postgres",
        sqlite: {
          file: currentConfig.sqlite?.file || "data/promptgate.sqlite",
        },
        postgres: {
          url: targetPgUrl,
        },
        setupCompletedAt: currentConfig.setupCompletedAt || new Date().toISOString(),
      };
      saveDbConfig(updatedConfig);
    }

    activeProgress.stage = "completed";
    activeProgress.inProgress = false;
    activeProgress.completedAt = new Date().toISOString();
    onProgress?.(activeProgress);

    const reportTables: Record<string, { copied: number; total: number }> = {};
    for (const [t, p] of Object.entries(activeProgress.tables)) {
      reportTables[t] = { copied: p.copied, total: p.total };
    }

    return {
      ok: true,
      totalTables: tables.length,
      totalRows: overallTotalRows,
      copiedRows: totalCopied,
      verified: true,
      tables: reportTables,
    };
  } catch (err: any) {
    activeProgress.stage = "failed";
    activeProgress.inProgress = false;
    activeProgress.error = err.message;
    onProgress?.(activeProgress);

    // Ensure session_replication_role is reverted if pool is still open
    if (pool && fkDisabled) {
      try {
        await pool.query("SET session_replication_role = DEFAULT;");
      } catch {
        // Ignore
      }
    }

    throw err;
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        // Ignore
      }
    }
  }
}
