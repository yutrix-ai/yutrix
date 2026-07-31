import { db } from "./db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import path from "path";
import crypto from "crypto";

import { ensureStrategyRoutingColumns, preSeedMigrations, isMigrationCompleted, ensureAnalyticsColumns, ensureAnalyticsIndexes, ensureTokenLimitColumns, ensureFunnelRoutingColumns, ensureProviderModelContextWindowColumn } from "./startup/migrations";
import { seedAdminUser, seedBrandingSettings, seedBuiltinPromptPolicies, syncManualModels, ensureDefaultGroup, seedModelDiscoverySettings } from "./startup/seed";

export { isMigrationCompleted };

async function ensureProviderApiKeysTable() {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS provider_api_keys (
      id text PRIMARY KEY NOT NULL,
      providerId text NOT NULL,
      keyEncrypted text NOT NULL,
      status text DEFAULT 'active' NOT NULL,
      createdAt integer NOT NULL,
      updatedAt integer NOT NULL,
      lastUsedAt integer
    )
  `);
}

async function migrateAndDropLegacyProviderKeyColumns() {
  const providersCheck = await db.run(sql`SELECT name FROM sqlite_master WHERE type='table' AND name='providers'`);
  if (providersCheck.rows.length === 0) return;

  await ensureProviderApiKeysTable();

  const info = await db.run(sql`PRAGMA table_info(providers)`);
  const columnNames = new Set(info.rows.map((row: any) => row[1]));
  const legacyColumns = ["openaiApiKeyEncrypted", "anthropicApiKeyEncrypted"].filter((column) => columnNames.has(column));
  if (legacyColumns.length === 0) return;

  const selectSql = `SELECT id, ${legacyColumns.map((column) => `"${column}"`).join(", ")} FROM providers`;
  const legacyRows = await db.run(sql.raw(selectSql));
  const now = Date.now();

  for (const row of legacyRows.rows as any[]) {
    const providerId = row[0];
    const seenInProvider = new Set<string>();
    for (let i = 0; i < legacyColumns.length; i++) {
      const encryptedKey = row[i + 1];
      if (!encryptedKey || seenInProvider.has(encryptedKey)) continue;
      seenInProvider.add(encryptedKey);

      const existing = await db.run(sql`
        SELECT id FROM provider_api_keys
        WHERE providerId = ${providerId} AND keyEncrypted = ${encryptedKey}
        LIMIT 1
      `);
      if (existing.rows.length === 0) {
        await db.run(sql`
          INSERT INTO provider_api_keys (id, providerId, keyEncrypted, status, createdAt, updatedAt)
          VALUES (${crypto.randomUUID()}, ${providerId}, ${encryptedKey}, 'active', ${now}, ${now})
        `);
      }
    }
  }

  const providerColumns = [
    { name: "id", ddl: "id text PRIMARY KEY NOT NULL", fallback: "lower(hex(randomblob(16)))" },
    { name: "name", ddl: "name text NOT NULL", fallback: "'Unnamed Provider'" },
    { name: "openaiBaseUrl", ddl: "openaiBaseUrl text", fallback: "NULL" },
    { name: "anthropicBaseUrl", ddl: "anthropicBaseUrl text", fallback: "NULL" },
    { name: "concurrencyLimit", ddl: "concurrencyLimit integer DEFAULT 10 NOT NULL", fallback: "10" },
    { name: "timeoutMs", ddl: "timeoutMs integer DEFAULT 60000 NOT NULL", fallback: "60000" },
    { name: "maxOutputTokens", ddl: "maxOutputTokens integer DEFAULT 0 NOT NULL", fallback: "0" },
    { name: "enabled", ddl: "enabled integer DEFAULT 1 NOT NULL", fallback: "1" },
    { name: "manualModels", ddl: "manualModels text", fallback: "NULL" },
    { name: "lastTestAt", ddl: "lastTestAt integer", fallback: "NULL" },
    { name: "lastTestStatus", ddl: "lastTestStatus text", fallback: "NULL" },
    { name: "lastTestMessage", ddl: "lastTestMessage text", fallback: "NULL" },
    { name: "upstreamProxyUrl", ddl: "upstreamProxyUrl text", fallback: "NULL" },
    { name: "weightProxyUrl", ddl: "weightProxyUrl text", fallback: "NULL" },
    { name: "createdAt", ddl: "createdAt integer NOT NULL", fallback: `${now}` },
    { name: "updatedAt", ddl: "updatedAt integer NOT NULL", fallback: `${now}` },
  ];
  const targetColumnNames = providerColumns.map((column) => `"${column.name}"`).join(", ");
  const selectExpressions = providerColumns
    .map((column) => columnNames.has(column.name) ? `"${column.name}"` : column.fallback)
    .join(", ");

  await db.run(sql`DROP TABLE IF EXISTS providers_without_legacy_keys`);
  await db.run(sql.raw(`
    CREATE TABLE providers_without_legacy_keys (
      ${providerColumns.map((column) => column.ddl).join(",\n      ")}
    )
  `));
  await db.run(sql.raw(`
    INSERT INTO providers_without_legacy_keys (${targetColumnNames})
    SELECT ${selectExpressions}
    FROM providers
  `));
  await db.run(sql`DROP TABLE providers`);
  await db.run(sql`ALTER TABLE providers_without_legacy_keys RENAME TO providers`);
  console.log("[PromptGate] Removed legacy provider protocol key columns.");
}

export async function bootstrap() {
  try {
    await db.run(sql`PRAGMA journal_mode=DELETE`);
    console.log("[PromptGate Bootstrap] Disabled SQLite WAL journal mode (reverted to DELETE).");
  } catch (err) {
    console.error("[PromptGate Bootstrap] Failed to set WAL journal mode:", err);
  }

  await ensureAnalyticsColumns();
  await ensureTokenLimitColumns();
  await preSeedMigrations();

  try {
    const tableCheck = await db.run(sql`SELECT name FROM sqlite_master WHERE type='table' AND name='provider_models'`);
    if (tableCheck.rows.length > 0) {
      console.log("[PromptGate] Deduplicating provider_models to enforce unique (providerId, modelId)...");
      await db.run(sql`
        DELETE FROM provider_models
        WHERE id NOT IN (
          SELECT min(id) FROM provider_models GROUP BY providerId, modelId
        )
      `);
    }
  } catch (err) {
    console.error("[PromptGate Bootstrap] Error during provider_models deduplication:", err);
  }

  console.log("[PromptGate] Running migrations...");
  const migrationsFolder = path.resolve(
    process.cwd(),
    process.cwd().endsWith("server") ? "./drizzle" : "apps/server/drizzle",
  );

  // Clean up any leftover temporary tables from previously failed Drizzle migrations
  // This must run BEFORE migrate() to prevent schema corruption on RENAME TO operations
  try {
    await db.run(sql.raw("DROP TABLE IF EXISTS __new_endpoint_routes;"));
    await db.run(sql.raw("DROP TABLE IF EXISTS __new_provider_models;"));
    await db.run(sql.raw("DROP TABLE IF EXISTS __new_providers;"));
    await db.run(sql.raw("DROP TABLE IF EXISTS __new_user_route_overrides;"));
  } catch (err) {
    console.error("[PromptGate Bootstrap] Warning: Failed to clean up temp tables before migration:", err);
  }

  await migrate(db, { migrationsFolder });
  console.log("[PromptGate] Migrations completed.");

  // Run auto migrations for missing columns
  const { initAutoMigrations } = await import("./db");
  await initAutoMigrations();
  console.log("[PromptGate] Auto-migrations completed.");

  // columns are migrated into the key pool and removed from the providers table.
  try {
    await migrateAndDropLegacyProviderKeyColumns();
  } catch (err) {
    console.error("[PromptGate Bootstrap] Error during provider API key migration:", err);
  }

  try { await db.run(sql`ALTER TABLE chat_logs ADD COLUMN responseHash text`); } catch { /* column already exists */ }
  try { await db.run(sql`ALTER TABLE endpoint_routes ADD COLUMN fallbackMatchTarget integer DEFAULT 0 NOT NULL`); } catch { /* column already exists */ }
  try { await db.run(sql`ALTER TABLE endpoint_routes ADD COLUMN schedules text`); } catch { /* column already exists */ }

  await ensureFunnelRoutingColumns();
  await ensureStrategyRoutingColumns();
  await ensureTokenLimitColumns();
  await ensureProviderModelContextWindowColumn();
  await ensureAnalyticsIndexes();

  try { await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS chat_logs_requestId_unique ON chat_logs (requestId)`); } catch { /* index already exists */ }
  try {
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_chat_logs_userid ON chat_logs (userId)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_chat_logs_serversessionid ON chat_logs (serverSessionId)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_chat_logs_createdat ON chat_logs (createdAt)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_chat_logs_user_created ON chat_logs (userId, createdAt)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS idx_chat_logs_responsehash ON chat_logs (responseHash)`);
  } catch { /* indexes already exist */ }

  await seedAdminUser();
  await seedBrandingSettings();
  await seedModelDiscoverySettings();
  await seedBuiltinPromptPolicies();
  await syncManualModels();
  await ensureDefaultGroup();
}
