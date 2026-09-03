import { drizzle as drizzleLibsql, LibSQLDatabase } from "drizzle-orm/libsql";
import { drizzle as drizzlePg, NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { Pool } from "pg";
import * as schemaSqlite from "./schema.sqlite";
import * as schemaPg from "./schema.pg";
import fs from "fs";
import path from "path";
import { resolveDbFilePath } from "./path";
import { loadDbConfig, YutrixDbConfig, DbDriver } from "./config";
import { migratePg } from "./migrate-pg";
import { setDefaultDialectDriver } from "./dialect";

export type LibSQLDb = LibSQLDatabase<typeof schemaSqlite>;
export type PgDb = NodePgDatabase<typeof schemaPg>;
export type AppDb = LibSQLDb & PgDb;

export interface CreateDbResult {
  db: AppDb;
  client: any;
  driver: DbDriver;
}

let currentDb: AppDb | null = null;
let currentClient: any = null;
let currentConfig: YutrixDbConfig | null = null;
let currentDriver: DbDriver | null = null;

export function getDb(): AppDb {
  if (!currentDb) {
    throw new Error("Database has not been initialized. Call await initDb() first.");
  }
  return currentDb;
}

export function getClient(): any {
  if (!currentClient) {
    throw new Error("Database client has not been initialized. Call await initDb() first.");
  }
  return currentClient;
}

export function getDbDriver(): DbDriver {
  return currentDriver || currentConfig?.driver || "sqlite";
}

export function isDbInitialized(): boolean {
  return currentDb !== null;
}

/**
 * Proxy for db export.
 * Delegates all property lookups to active currentDb.
 * Throws a descriptive error if accessed before initDb() is called.
 */
export let db: AppDb = new Proxy({} as AppDb, {
  get(target, prop, receiver) {
    if (!currentDb) {
      if (prop === "then") return undefined;
      if (prop === "toJSON") return () => "[Uninitialized Database]";
      if (prop === Symbol.toStringTag) return "Database";
      if (prop === Symbol.for("nodejs.util.inspect.custom")) {
        return () => "[Uninitialized Database]";
      }
      throw new Error("Database has not been initialized. Call await initDb() first.");
    }
    // Polyfill db.run on PostgreSQL instances (delegates to db.execute)
    if (
      prop === "run" &&
      !Reflect.has(currentDb, "run") &&
      typeof (currentDb as any).execute === "function"
    ) {
      return (currentDb as any).execute.bind(currentDb);
    }
    const val = Reflect.get(currentDb, prop);
    return typeof val === "function" ? val.bind(currentDb) : val;
  },
  has(target, prop) {
    if (!currentDb) {
      throw new Error("Database has not been initialized. Call await initDb() first.");
    }
    return Reflect.has(currentDb, prop);
  },
  apply(target, thisArg, argArray) {
    if (!currentDb) {
      throw new Error("Database has not been initialized. Call await initDb() first.");
    }
    return Reflect.apply(currentDb as any, thisArg, argArray);
  },
});

/**
 * Proxy for client export.
 * Delegates all property lookups to active currentClient.
 * Throws a descriptive error if accessed before initDb() is called.
 */
export let client: any = new Proxy({} as any, {
  get(target, prop, receiver) {
    if (!currentClient) {
      if (prop === "then") return undefined;
      if (prop === "toJSON") return () => "[Uninitialized Client]";
      if (prop === Symbol.toStringTag) return "Client";
      if (prop === Symbol.for("nodejs.util.inspect.custom")) {
        return () => "[Uninitialized Client]";
      }
      throw new Error("Database client has not been initialized. Call await initDb() first.");
    }
    // Cross-engine polyfill: client.execute on Postgres Pool
    if (
      prop === "execute" &&
      !Reflect.has(currentClient, "execute") &&
      typeof currentClient.query === "function"
    ) {
      return async (queryArg: any, params?: any[]) => {
        if (typeof queryArg === "object" && queryArg !== null && "sql" in queryArg) {
          const res = await currentClient.query(queryArg.sql, queryArg.args);
          return { rows: res.rows };
        }
        const res = await currentClient.query(queryArg, params);
        return { rows: res.rows };
      };
    }
    // Cross-engine polyfill: client.query on LibSQL Client
    if (
      prop === "query" &&
      !Reflect.has(currentClient, "query") &&
      typeof currentClient.execute === "function"
    ) {
      return async (queryArg: any, params?: any[]) => {
        if (typeof queryArg === "string") {
          const res = await currentClient.execute({ sql: queryArg, args: params || [] });
          return { rows: res.rows };
        }
        const res = await currentClient.execute(queryArg);
        return { rows: res.rows };
      };
    }
    const val = Reflect.get(currentClient, prop);
    return typeof val === "function" ? val.bind(currentClient) : val;
  },
  has(target, prop) {
    if (!currentClient) {
      throw new Error("Database client has not been initialized. Call await initDb() first.");
    }
    return Reflect.has(currentClient, prop);
  },
});

/**
 * Creates a new DB connection and Drizzle instance without mutating global state.
 */
export async function createDb(config?: YutrixDbConfig): Promise<CreateDbResult> {
  const cfg = config ?? loadDbConfig();

  if (cfg.driver === "postgres") {
    const url = cfg.postgres?.url;
    if (!url) {
      throw new Error(
        "PostgreSQL URL is required when driver is postgres (set DATABASE_URL or postgres.url in config)"
      );
    }
    const pool = new Pool({
      connectionString: url,
    });
    const createdDb = drizzlePg(pool, { schema: schemaPg, logger: true });
    return { db: createdDb as unknown as AppDb, client: pool, driver: "postgres" };
  }

  const rawFile = cfg.sqlite?.file || "data/promptgate.sqlite";
  const resolvedPath = resolveDbFilePath(rawFile, process.cwd());

  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const createdClient = createClient({ url: "file:" + resolvedPath });
  const createdDb = drizzleLibsql(createdClient, { schema: schemaSqlite, logger: true });

  return { db: createdDb as unknown as AppDb, client: createdClient, driver: "sqlite" };
}

function isSameConfig(a: YutrixDbConfig, b: YutrixDbConfig): boolean {
  if (a.driver !== b.driver) return false;
  if (a.driver === "sqlite") {
    const fileA = resolveDbFilePath(a.sqlite?.file || "data/promptgate.sqlite", process.cwd());
    const fileB = resolveDbFilePath(b.sqlite?.file || "data/promptgate.sqlite", process.cwd());
    return fileA === fileB;
  }
  if (a.driver === "postgres") {
    return a.postgres?.url === b.postgres?.url;
  }
  return false;
}

/**
 * Initializes the database connection asynchronously.
 * Sets the active `db` and `client` singleton instances.
 * When driver=postgres, automatically executes PG migrations per PRD §7.4.
 */
export async function initDb(config?: YutrixDbConfig): Promise<AppDb> {
  const targetConfig = config ?? loadDbConfig();

  // Reuse existing connection if configuration is identical
  if (currentDb && currentConfig && isSameConfig(currentConfig, targetConfig)) {
    return currentDb;
  }

  // Close previous connection if one exists
  if (currentClient) {
    try {
      if (typeof currentClient.end === "function") {
        await currentClient.end();
      } else if (typeof currentClient.close === "function") {
        await currentClient.close();
      }
    } catch {
      // Ignore errors when closing old client
    }
  }

  const result = await createDb(targetConfig);
  currentDb = result.db;
  currentClient = result.client;
  currentConfig = targetConfig;
  currentDriver = result.driver;
  setDefaultDialectDriver(result.driver);

  // Auto-run PG migrations on PostgreSQL driver initialization per Slice P0-3
  if (result.driver === "postgres") {
    await migratePg(currentDb as PgDb);
  }

  return currentDb;
}

/**
 * Closes the active database connection and resets initialized state.
 */
export async function closeDb(): Promise<void> {
  if (currentClient) {
    try {
      if (typeof currentClient.end === "function") {
        await currentClient.end();
      } else if (typeof currentClient.close === "function") {
        await currentClient.close();
      }
    } catch {
      // Ignore errors when closing client
    }
  }
  currentDb = null;
  currentClient = null;
  currentConfig = null;
  currentDriver = null;
  setDefaultDialectDriver("sqlite");
}

/**
 * Idempotent auto-migrations that run on every startup for SQLite.
 * Each entry safely adds a column if it doesn't already exist.
 * SQLite's ALTER TABLE ADD COLUMN will error with "duplicate column name"
 * if it already exists — we catch and ignore that specific error.
 */
async function runAutoMigrations() {
  const migrations = [
    // ── providers ──
    "ALTER TABLE providers ADD COLUMN upstreamProxyUrl text;",
    "ALTER TABLE providers ADD COLUMN weightProxyUrl text;",
    "ALTER TABLE providers ADD COLUMN hourlyTokenLimit integer DEFAULT 0;",

    // ── provider_models ──
    "ALTER TABLE provider_models ADD COLUMN maxOutputTokens integer;",
    "ALTER TABLE provider_models ADD COLUMN contextWindowTokens integer;",
    "ALTER TABLE provider_models ADD COLUMN inputTokenPricePerM real;",
    "ALTER TABLE provider_models ADD COLUMN outputTokenPricePerM real;",
    "ALTER TABLE provider_models ADD COLUMN tokenizerRepo text;",
    "ALTER TABLE provider_models ADD COLUMN active integer DEFAULT 1 NOT NULL;",

    // ── endpoints ──
    "ALTER TABLE endpoints ADD COLUMN timeoutMs integer DEFAULT 0 NOT NULL;",
    "ALTER TABLE endpoints ADD COLUMN queueTimeoutMs integer DEFAULT 0 NOT NULL;",
    "ALTER TABLE endpoints ADD COLUMN maxBodyMb integer DEFAULT 0 NOT NULL;",

    // ── endpoint_routes ──
    "ALTER TABLE endpoint_routes ADD COLUMN name text DEFAULT '';",
    "ALTER TABLE endpoint_routes ADD COLUMN subdomainId text;",
    "ALTER TABLE endpoint_routes ADD COLUMN providerProtocol text DEFAULT 'openai' NOT NULL;",
    "ALTER TABLE endpoint_routes ADD COLUMN promptPolicyId text;",
    "ALTER TABLE endpoint_routes ADD COLUMN fallbackEnabled integer DEFAULT 0 NOT NULL;",
    "ALTER TABLE endpoint_routes ADD COLUMN fallbackProviderId text;",
    "ALTER TABLE endpoint_routes ADD COLUMN fallbackProviderProtocol text;",
    "ALTER TABLE endpoint_routes ADD COLUMN fallbackModelId text;",
    "ALTER TABLE endpoint_routes ADD COLUMN fallbackPromptPolicyId text;",
    "ALTER TABLE endpoint_routes ADD COLUMN fallbackMatchTarget integer DEFAULT 0 NOT NULL;",
    "ALTER TABLE endpoint_routes ADD COLUMN fallbackStrategyRoutingEnabled integer DEFAULT 0 NOT NULL;",
    "ALTER TABLE endpoint_routes ADD COLUMN fallbackStrategyRoutingRules text;",
    "ALTER TABLE endpoint_routes ADD COLUMN strategyRoutingEnabled integer DEFAULT 0 NOT NULL;",
    "ALTER TABLE endpoint_routes ADD COLUMN strategyRoutingRules text;",
    "ALTER TABLE endpoint_routes ADD COLUMN allowClientModel integer DEFAULT 0 NOT NULL;",
    "ALTER TABLE endpoint_routes ADD COLUMN schedules text;",
    "ALTER TABLE endpoint_routes ADD COLUMN ipWhitelist text;",

    // ── users ──
    "ALTER TABLE users ADD COLUMN maxInputTokensOverride integer;",

    // ── request_logs ──
    "ALTER TABLE request_logs ADD COLUMN cacheReadTokens integer DEFAULT 0;",
    "ALTER TABLE request_logs ADD COLUMN cacheWriteTokens integer DEFAULT 0;",
    "ALTER TABLE request_logs ADD COLUMN ttftMs integer DEFAULT 0;",
    "ALTER TABLE request_logs ADD COLUMN cost real;",
    "ALTER TABLE request_logs ADD COLUMN routingTrace text;",

    // ── user_route_overrides ──
    "ALTER TABLE user_route_overrides ADD COLUMN strategyRoutingRules text;",
    "ALTER TABLE user_route_overrides ADD COLUMN useClientModel integer DEFAULT 0 NOT NULL;",

    // ── chat_logs ──
    "ALTER TABLE chat_logs ADD COLUMN conversationRootHash text;",
    "ALTER TABLE chat_logs ADD COLUMN ttft_ms integer;",
    "ALTER TABLE chat_logs ADD COLUMN cached_tokens integer DEFAULT 0;",
    "ALTER TABLE chat_logs ADD COLUMN is_aborted integer DEFAULT 0;",
    "ALTER TABLE providers DROP COLUMN openaiApiKeyEncrypted;",
    "ALTER TABLE providers DROP COLUMN anthropicApiKeyEncrypted;",
  ];

  for (const query of migrations) {
    try {
      await (db as any).run(sql.raw(query));
    } catch (e: any) {
      const msg = String(e.cause?.message || e.message || "").toLowerCase();
      if (!msg.includes("duplicate column") && !msg.includes("no such column")) {
        console.error(">>> [runAutoMigrations] Fatal error on query:", query, e);
        throw e;
      }
    }
  }

  // Cleanup any leftover temp tables from failed drizzle-kit push attempts
  await (db as any).run(sql.raw("DROP TABLE IF EXISTS __new_user_route_overrides;")).catch(() => {});
  await (db as any).run(sql.raw("DROP TABLE IF EXISTS __new_providers;")).catch(() => {});
  await (db as any).run(sql.raw("DROP TABLE IF EXISTS __new_provider_models;")).catch(() => {});
  await client.execute("DROP TABLE IF EXISTS __new_endpoint_routes;").catch(() => {});

  // Force cache invalidation / transaction reset for LibSQL/Drizzle connections
  try {
    await (db as any).run(sql.raw("BEGIN IMMEDIATE"));
    await (db as any).run(sql.raw("COMMIT"));
    await (db as any).run(sql.raw("PRAGMA schema_version"));
  } catch (e: any) {
    // Ignore errors here
  }
}

// Create tables that may not exist yet (for brand new installs from very old versions)
async function ensureTablesExist() {
  const tableSqls = [
    `CREATE TABLE IF NOT EXISTS user_route_overrides (
      id text PRIMARY KEY NOT NULL,
      userId text NOT NULL,
      routeId text NOT NULL,
      modelId text,
      useClientModel integer DEFAULT 0 NOT NULL,
      strategyRoutingRules text,
      createdAt integer NOT NULL,
      updatedAt integer NOT NULL
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS unq_user_route ON user_route_overrides (userId, routeId);`,
    `CREATE TABLE IF NOT EXISTS user_groups (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL UNIQUE,
      description text,
      isDefault integer DEFAULT 0 NOT NULL,
      maxInputTokens integer DEFAULT 0 NOT NULL,
      createdAt integer NOT NULL,
      updatedAt integer NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS user_group_members (
      id text PRIMARY KEY NOT NULL,
      groupId text NOT NULL,
      userId text NOT NULL,
      createdAt integer NOT NULL
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS unq_group_user ON user_group_members (groupId, userId);`,
    `CREATE TABLE IF NOT EXISTS route_authorizations (
      id text PRIMARY KEY NOT NULL,
      routeId text NOT NULL,
      userId text,
      groupId text,
      createdAt integer NOT NULL
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS unq_route_user ON route_authorizations (routeId, userId);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS unq_route_group ON route_authorizations (routeId, groupId);`,
    `CREATE TABLE IF NOT EXISTS openapi_keys (
      id text PRIMARY KEY NOT NULL,
      userId text NOT NULL,
      name text NOT NULL,
      keyHash text NOT NULL,
      keyPrefix text NOT NULL,
      status text DEFAULT 'active' NOT NULL,
      createdAt integer NOT NULL,
      lastUsedAt integer
    );`,
    `CREATE TABLE IF NOT EXISTS response_cache (
      id text PRIMARY KEY NOT NULL,
      inputHash text NOT NULL,
      inputText text NOT NULL,
      responseText text NOT NULL,
      model text,
      sourceLogId text,
      hitCount integer DEFAULT 0 NOT NULL,
      lastHitAt integer,
      createdBy text,
      createdAt integer NOT NULL,
      updatedAt integer NOT NULL
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS unq_response_cache_inputhash ON response_cache (inputHash);`,
    `CREATE TABLE IF NOT EXISTS provider_api_keys (
      id text PRIMARY KEY NOT NULL,
      providerId text NOT NULL,
      keyEncrypted text NOT NULL,
      status text DEFAULT 'active' NOT NULL,
      createdAt integer NOT NULL,
      updatedAt integer NOT NULL,
      lastUsedAt integer
    );`,
    `CREATE TABLE IF NOT EXISTS distillation_jobs (
      id text PRIMARY KEY NOT NULL,
      mode text NOT NULL,
      status text DEFAULT 'pending' NOT NULL,
      analysisRouteId text,
      userIdsFilter text,
      timeRangeStart integer,
      timeRangeEnd integer,
      maxRecords integer,
      totalItems integer DEFAULT 0 NOT NULL,
      processedItems integer DEFAULT 0 NOT NULL,
      failedItems integer DEFAULT 0 NOT NULL,
      errorMessage text,
      generationId text NOT NULL,
      startedAt integer,
      completedAt integer,
      createdAt integer NOT NULL
    );`,
    `CREATE INDEX IF NOT EXISTS idx_distillation_jobs_status ON distillation_jobs (status);`,
    `CREATE TABLE IF NOT EXISTS distillation_job_items (
      id text PRIMARY KEY NOT NULL,
      jobId text NOT NULL,
      chatLogId text NOT NULL,
      userId text NOT NULL,
      status text DEFAULT 'pending' NOT NULL,
      errorMessage text,
      processedAt integer,
      createdAt integer NOT NULL
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS unq_distillation_job_chatlog ON distillation_job_items (jobId, chatLogId);`,
    `CREATE TABLE IF NOT EXISTS distillation_learned_records (
      chatLogId text PRIMARY KEY NOT NULL,
      jobId text NOT NULL,
      generationId text NOT NULL,
      learnedAt integer NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS distillation_routing_proposals (
      id text PRIMARY KEY NOT NULL,
      jobId text NOT NULL,
      chatLogId text,
      sourceUserId text,
      status text DEFAULT 'draft' NOT NULL,
      payload text NOT NULL,
      validationResult text,
      createdAt integer NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS distillation_signal_versions (
      id text PRIMARY KEY NOT NULL,
      versionLabel text NOT NULL,
      weightOverrides text NOT NULL,
      boundaryRules text NOT NULL,
      proposalIds text NOT NULL,
      isActive integer DEFAULT 0 NOT NULL,
      createdAt integer NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS distillation_skill_packages (
      id text PRIMARY KEY NOT NULL,
      userId text NOT NULL,
      username text NOT NULL,
      version integer NOT NULL,
      status text DEFAULT 'draft' NOT NULL,
      files text NOT NULL,
      sourceRecordCount integer DEFAULT 0 NOT NULL,
      jobId text,
      createdAt integer NOT NULL
    );`
  ];

  for (const query of tableSqls) {
    try {
      await (db as any).run(sql.raw(query));
    } catch (e: any) {
      if (!e.message?.includes("already exists")) {
        console.warn("[auto-migrate:table]", e.message);
      }
    }
  }
}

export const initAutoMigrations = async () => {
  if (!currentDb) {
    await initDb();
  }
  // Auto-migrations apply only to SQLite
  if (getDbDriver() === "sqlite") {
    await ensureTablesExist();
    await runAutoMigrations();
  }
};
