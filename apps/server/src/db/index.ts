import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import { createClient } from "@libsql/client";
import * as schema from "./schema";
import dotenv from "dotenv";

const envPath = process.cwd().endsWith("server") ? "../../.env" : ".env";
dotenv.config({ path: envPath });

// Path is relative to the current working directory where the server is started
const dbPath = process.env.DB_FILE || "data/promptgate.sqlite";

import { resolveDbFilePath } from './path';

const getDbPath = () => resolveDbFilePath(dbPath, process.cwd());

export const client = createClient({ url: "file:" + getDbPath() });
export const db = drizzle(client, { schema, logger: true });

/**
 * Idempotent auto-migrations that run on every startup.
 * Each entry safely adds a column if it doesn't already exist.
 * SQLite's ALTER TABLE ADD COLUMN will error with "duplicate column name"
 * if it already exists — we catch and ignore that specific error.
 *
 * This ensures users upgrading from ANY older version get a working DB
 * without needing to run drizzle-kit push (which is unreliable on SQLite).
 *
 * HOW TO ADD A NEW MIGRATION:
 *   1. Append a new entry to the `migrations` array below.
 *   2. Use the exact SQL: ALTER TABLE <table> ADD COLUMN <col> <type> [DEFAULT <val>];
 *   3. Never remove old entries — they are idempotent and harmless.
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
      await db.run(sql.raw(query));
    } catch (e: any) {
      const msg = String(e.cause?.message || e.message || "").toLowerCase();
      if (!msg.includes("duplicate column") && !msg.includes("no such column")) {
        console.error(">>> [runAutoMigrations] Fatal error on query:", query, e);
        throw e;
      }
    }
  }

  // Cleanup any leftover temp tables from failed drizzle-kit push attempts
  await db.run(sql.raw("DROP TABLE IF EXISTS __new_user_route_overrides;")).catch(() => {});
  await db.run(sql.raw("DROP TABLE IF EXISTS __new_providers;")).catch(() => {});
  await db.run(sql.raw("DROP TABLE IF EXISTS __new_provider_models;")).catch(() => {});
  await client.execute("DROP TABLE IF EXISTS __new_endpoint_routes;").catch(() => {});

  // Force cache invalidation / transaction reset for LibSQL/Drizzle connections
  // This ensures that the schema changes are immediately visible to subsequent queries.
  try {
    await db.run(sql.raw("BEGIN IMMEDIATE"));
    await db.run(sql.raw("COMMIT"));
    await db.run(sql.raw("PRAGMA schema_version"));
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
    );`
  ];

  for (const query of tableSqls) {
    try {
      await db.run(sql.raw(query));
    } catch (e: any) {
      // Ignore "already exists" errors
      if (!e.message?.includes("already exists")) {
        console.warn("[auto-migrate:table]", e.message);
      }
    }
  }
}

export const initAutoMigrations = async () => {
  await ensureTablesExist();
  await runAutoMigrations();
};
