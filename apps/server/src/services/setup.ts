import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import { Pool } from "pg";
import { db, initDb, isDbInitialized, getDbDriver, LibSQLDb, PgDb } from "../db";
import { loadDbConfig, saveDbConfig, YutrixDbConfig, DbDriver } from "../db/config";
import { resolveDbFilePath } from "../db/path";
import { migratePg } from "../db/migrate-pg";
import { migrateSqlite } from "../db/migrate-sqlite";
import { users, systemSettings } from "../db/schema";
import {
  seedBrandingSettings,
  seedDefaultApiKeyConcurrency,
  seedModelDiscoverySettings,
  seedLoopGuardSettings,
  seedBuiltinPromptPolicies,
  syncManualModels,
  ensureDefaultGroup,
} from "../startup/seed";
import {
  ensureFunnelRoutingColumns,
  ensureStrategyRoutingColumns,
  ensureProviderModelContextWindowColumn,
  ensureTokenLimitColumns,
  ensureAnalyticsColumns,
  ensureAnalyticsIndexes,
  ensureSubdomainHostnameIdentity,
} from "../startup/migrations";
import { refreshLoopGuardConfigCache } from "./loopGuard";
import { refreshRoutingWeightSnapshot } from "./distillation/routingWeightsBridge";

let setupPendingState = false;
let setupCompletedInMemory = false;

export function getSetupPending(): boolean {
  return setupPendingState;
}

export function setSetupPending(val: boolean): void {
  setupPendingState = val;
}

export function resetSetupCompletedInMemory(): void {
  setupCompletedInMemory = false;
}

/**
 * Determines if the current environment is a fresh installation.
 * Criteria per PRD Section 6 & Slice P0-4:
 * 1. SETUP_FORCE=1 -> always fresh (debug override).
 * 2. If completed in current memory session -> not fresh.
 * 3. No DB / no users table / users count 0 -> fresh.
 */
export async function isFreshInstall(): Promise<boolean> {
  if (process.env.SETUP_FORCE === "1" || process.env.SETUP_FORCE === "true") {
    return true;
  }

  if (setupCompletedInMemory) {
    return false;
  }

  const config = loadDbConfig();

  // If config already recorded setup completion, check if users exist
  if (config.driver === "sqlite") {
    const rawFile = config.sqlite?.file || "data/promptgate.sqlite";
    const resolvedPath = resolveDbFilePath(rawFile, process.cwd());
    if (!fs.existsSync(resolvedPath)) {
      return true;
    }
  }

  try {
    if (!isDbInitialized()) {
      await initDb(config);
    }
    const userCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(users);
    const count = Number(userCountResult[0]?.count ?? 0);
    return count === 0;
  } catch (err: any) {
    const msg = String(err.message || "").toLowerCase();
    // If users table is not yet created or DB is uninitialized, treat as fresh
    if (
      msg.includes("no such table") ||
      msg.includes("relation") ||
      msg.includes("does not exist") ||
      msg.includes("not been initialized")
    ) {
      return true;
    }
    return true;
  }
}

/**
 * Checks whether unattended environment variables are provided.
 */
export function hasUnattendedEnv(): boolean {
  return Boolean(
    process.env.YUTRIX_ADMIN_USER &&
    process.env.YUTRIX_ADMIN_PASSWORD &&
    process.env.YUTRIX_MAIN_DOMAIN &&
    process.env.PROMPTGATE_SECRET
  );
}

export interface TestDbParams {
  driver: DbDriver;
  sqliteFile?: string;
  databaseUrl?: string;
}

export interface TestDbResult {
  ok: boolean;
  message?: string;
  error?: string;
}

/**
 * Tests database connection parameters before applying them.
 */
export async function testDbConnection(params: TestDbParams): Promise<TestDbResult> {
  if (params.driver === "postgres") {
    const url = params.databaseUrl;
    if (!url) {
      return { ok: false, error: "PostgreSQL database URL is required" };
    }
    let pool: Pool | null = null;
    try {
      pool = new Pool({
        connectionString: url,
        connectionTimeoutMillis: 4000,
      });
      await pool.query("SELECT 1 as val;");
      return { ok: true, message: "Connected to PostgreSQL database successfully" };
    } catch (err: any) {
      return { ok: false, error: err.message || "Failed to connect to PostgreSQL" };
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

  if (params.driver === "sqlite") {
    try {
      const file = params.sqliteFile || "data/promptgate.sqlite";
      const resolved = resolveDbFilePath(file, process.cwd());
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.accessSync(dir, fs.constants.W_OK);
      return { ok: true, message: "SQLite database directory is valid and writable" };
    } catch (err: any) {
      return { ok: false, error: err.message || "SQLite directory is not writable" };
    }
  }

  return { ok: false, error: "Invalid driver specified" };
}

export interface CompleteSetupParams {
  username: string;
  password: string;
  mainDomain: string;
  secret: string;
  driver: DbDriver;
  sqliteFile?: string;
  databaseUrl?: string;
  siteTitle?: string;
}

/**
 * Completes the setup wizard:
 * 1. Validates freshness.
 * 2. Writes data/yutrix.config.json (mode 0600).
 * 3. Initializes DB connection and runs migrations.
 * 4. Hashes password using bcrypt and creates admin user (never logged).
 * 5. Seeds system settings, branding, and default groups.
 */
export async function completeSetup(params: CompleteSetupParams): Promise<{
  ok: boolean;
  admin: { id: string; username: string; role: string };
  config: YutrixDbConfig;
}> {
  const fresh = await isFreshInstall();
  if (!fresh) {
    const error: any = new Error("Setup has already been completed");
    error.statusCode = 409;
    throw error;
  }

  const username = params.username?.trim();
  if (!username) {
    const error: any = new Error("Admin username is required");
    error.statusCode = 400;
    throw error;
  }

  const password = params.password;
  if (!password || password.length < 8) {
    const error: any = new Error("Password must be at least 8 characters long");
    error.statusCode = 400;
    throw error;
  }

  const mainDomain = params.mainDomain?.trim();
  if (!mainDomain) {
    const error: any = new Error("Main domain is required");
    error.statusCode = 400;
    throw error;
  }

  const secret = params.secret?.trim();
  if (!secret || secret.length < 16) {
    const error: any = new Error("Secret key must be at least 16 characters long");
    error.statusCode = 400;
    throw error;
  }

  if (params.driver === "postgres" && !params.databaseUrl) {
    const error: any = new Error("PostgreSQL URL is required when driver is postgres");
    error.statusCode = 400;
    throw error;
  }

  const completedAt = new Date().toISOString();
  const newConfig: YutrixDbConfig = {
    version: 1,
    driver: params.driver,
    sqlite: {
      file: params.sqliteFile || "data/promptgate.sqlite",
    },
    postgres: {
      url: params.driver === "postgres" ? params.databaseUrl || "" : "",
    },
    setupCompletedAt: completedAt,
  };

  // 1. Save config with 0600 mode
  saveDbConfig(newConfig);

  // 2. Set runtime environment variables
  process.env.PROMPTGATE_SECRET = secret;
  process.env.YUTRIX_MAIN_DOMAIN = mainDomain;
  process.env.DB_DRIVER = params.driver;
  if (params.driver === "postgres") {
    process.env.DATABASE_URL = params.databaseUrl;
  } else {
    process.env.DB_FILE = params.sqliteFile || "data/promptgate.sqlite";
  }

  // 3. Connect to target DB and run migrations
  await initDb(newConfig);

  if (params.driver === "postgres") {
    await migratePg(db as PgDb);
  } else {
    await migrateSqlite(db as LibSQLDb);
    await ensureFunnelRoutingColumns();
    await ensureStrategyRoutingColumns();
    await ensureProviderModelContextWindowColumn();
    await ensureTokenLimitColumns();
    await ensureAnalyticsColumns();
    await ensureAnalyticsIndexes();
    await ensureSubdomainHostnameIdentity();
  }

  // 4. Seed admin user (password hashed with bcrypt; never logged)
  const adminId = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, 10);

  // Check if admin user already exists (e.g. SETUP_FORCE=1)
  const existingAdmin = await db
    .select()
    .from(users)
    .where(eq(users.username, username));

  if (existingAdmin.length === 0) {
    await (db as any).insert(users).values({
      id: adminId,
      username,
      passwordHash,
      role: "admin",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } else {
    await (db as any)
      .update(users)
      .set({
        passwordHash,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existingAdmin[0].id));
  }

  // 5. Seed system settings
  await (db as any)
    .insert(systemSettings)
    .values({
      key: "mainDomain",
      value: mainDomain,
      description: "Primary system access domain",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: mainDomain, updatedAt: new Date() },
    });

  if (params.siteTitle) {
    await (db as any)
      .insert(systemSettings)
      .values({
        key: "siteTitle",
        value: params.siteTitle,
        description: "Custom site title",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: params.siteTitle, updatedAt: new Date() },
      });
  }

  // 6. Seed other standard settings & initial entities
  await seedBrandingSettings();
  await seedDefaultApiKeyConcurrency();
  await seedModelDiscoverySettings();
  await seedLoopGuardSettings();
  await refreshLoopGuardConfigCache();
  await refreshRoutingWeightSnapshot();
  await seedBuiltinPromptPolicies();
  await syncManualModels();
  await ensureDefaultGroup();

  // 7. Mark setup state
  setupCompletedInMemory = true;
  setSetupPending(false);

  return {
    ok: true,
    admin: { id: adminId, username, role: "admin" },
    config: newConfig,
  };
}

/**
 * Performs unattended setup using environment variables without interactive wizard.
 */
export async function performUnattendedSetup(): Promise<void> {
  const driver: DbDriver =
    process.env.DATABASE_URL?.startsWith("postgres") ||
    process.env.DB_DRIVER === "postgres"
      ? "postgres"
      : "sqlite";

  await completeSetup({
    username: process.env.YUTRIX_ADMIN_USER!,
    password: process.env.YUTRIX_ADMIN_PASSWORD!,
    mainDomain: process.env.YUTRIX_MAIN_DOMAIN!,
    secret: process.env.PROMPTGATE_SECRET!,
    driver,
    databaseUrl: process.env.DATABASE_URL,
    sqliteFile: process.env.DB_FILE,
  });

  console.log(
    `[PromptGate] Unattended setup completed successfully for administrator "${process.env.YUTRIX_ADMIN_USER}".`
  );
}
