import { db } from "../db";
import { sql } from "drizzle-orm";
import path from "path";
import fs from "fs";

export async function tableExists(tableName: string): Promise<boolean> {
  const result = await db.run(sql`
    SELECT name FROM sqlite_master WHERE type='table' AND name=${tableName}
  `);
  return result.rows.length > 0;
}

export async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  if (!(await tableExists(tableName))) return false;
  const info = await db.run(sql.raw(`PRAGMA table_info(${tableName})`));
  return info.rows.some((row: any) => row[1] === columnName);
}

export async function addColumnIfMissing(tableName: string, columnName: string, ddl: string) {
  if (!(await tableExists(tableName))) return;
  if (await columnExists(tableName, columnName)) return;
  try {
    await db.run(sql.raw(ddl));
    console.log(`[PromptGate] Added ${columnName} column to ${tableName}.`);
  } catch (err: any) {
    if (!String(err?.message || "").includes("duplicate column name")) {
      throw err;
    }
  }
}

export async function ensureStrategyRoutingColumns() {
  await addColumnIfMissing("endpoint_routes", "strategyRoutingEnabled", "ALTER TABLE endpoint_routes ADD COLUMN strategyRoutingEnabled integer DEFAULT 0 NOT NULL");
  await addColumnIfMissing("endpoint_routes", "strategyRoutingRules", "ALTER TABLE endpoint_routes ADD COLUMN strategyRoutingRules text");
  await addColumnIfMissing("request_logs", "routingTrace", "ALTER TABLE request_logs ADD COLUMN routingTrace text");
}

export async function ensureAnalyticsColumns() {
  await addColumnIfMissing("request_logs", "providerApiKeyId", "ALTER TABLE request_logs ADD COLUMN providerApiKeyId text");
  // TUQS 2.0 telemetry columns on chat_logs
  await addColumnIfMissing("chat_logs", "ttft_ms", "ALTER TABLE chat_logs ADD COLUMN ttft_ms integer");
  await addColumnIfMissing("chat_logs", "cached_tokens", "ALTER TABLE chat_logs ADD COLUMN cached_tokens integer DEFAULT 0");
  await addColumnIfMissing("chat_logs", "is_aborted", "ALTER TABLE chat_logs ADD COLUMN is_aborted integer DEFAULT 0");
}

/** Hostname is subdomain identity. First-label `name` may be shared across FQDNs. */
export async function ensureSubdomainHostnameIdentity() {
  if (!(await tableExists("subdomains"))) return;
  await db.run(sql.raw("DROP INDEX IF EXISTS subdomains_name_unique"));
}

export async function ensureAnalyticsIndexes() {
  if (!(await tableExists("request_logs"))) return;
  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_request_logs_createdat ON request_logs (createdAt)",
    "CREATE INDEX IF NOT EXISTS idx_request_logs_user_created ON request_logs (userId, createdAt)",
    "CREATE INDEX IF NOT EXISTS idx_request_logs_provider_created ON request_logs (providerId, createdAt)",
    "CREATE INDEX IF NOT EXISTS idx_request_logs_model_created ON request_logs (model, createdAt)",
    "CREATE INDEX IF NOT EXISTS idx_request_logs_endpoint_created ON request_logs (endpointId, createdAt)",
    "CREATE INDEX IF NOT EXISTS idx_request_logs_subdomain_created ON request_logs (subdomainId, createdAt)",
    "CREATE INDEX IF NOT EXISTS idx_request_logs_api_key_created ON request_logs (apiKeyId, createdAt)",
  ];
  for (const ddl of indexes) {
    await db.run(sql.raw(ddl));
  }
}

export async function ensureTokenLimitColumns() {
  await addColumnIfMissing("user_groups", "maxInputTokens", "ALTER TABLE user_groups ADD COLUMN maxInputTokens integer DEFAULT 0 NOT NULL");
  await addColumnIfMissing("users", "maxInputTokensOverride", "ALTER TABLE users ADD COLUMN maxInputTokensOverride integer");
}

/** Model-level context window (routing) — independent of maxOutputTokens (output clamp). */
export async function ensureProviderModelContextWindowColumn() {
  await addColumnIfMissing(
    "provider_models",
    "contextWindowTokens",
    "ALTER TABLE provider_models ADD COLUMN contextWindowTokens integer",
  );
}

export async function ensureFunnelRoutingColumns() {
  await addColumnIfMissing("provider_models", "alias", "ALTER TABLE provider_models ADD COLUMN alias text");
  await addColumnIfMissing("endpoint_routes", "targets", "ALTER TABLE endpoint_routes ADD COLUMN targets text");
  await addColumnIfMissing(
    "user_route_overrides",
    "useClientModel",
    "ALTER TABLE user_route_overrides ADD COLUMN useClientModel integer DEFAULT 0 NOT NULL",
  );

  // Data migration: convert old route target logic to the targets JSON array
  if (await tableExists("endpoint_routes")) {
    const routes = await db.run(sql`SELECT id, providerId, modelId, promptPolicyId, strategyRoutingEnabled, strategyRoutingRules, fallbackEnabled, fallbackProviderId, fallbackModelId, fallbackPromptPolicyId, fallbackMatchTarget, fallbackStrategyRoutingEnabled, fallbackStrategyRoutingRules, targets FROM endpoint_routes`);
    for (const route of routes.rows as any[]) {
      if (!route[13]) { // targets is null or empty
        const newTargets: any[] = [];
        // First target
        newTargets.push({
          providerId: route[1],
          modelId: route[2],
          promptPolicyId: route[3] || undefined,
          strategyRoutingEnabled: Boolean(route[4]),
          strategyRoutingRules: route[5] ? JSON.parse(route[5]) : [],
          bestEffort: false
        });

        // Second target if fallback is enabled
        if (route[6] && route[7] && route[7] !== "none") {
          newTargets.push({
            providerId: route[7],
            modelId: route[8],
            promptPolicyId: route[9] || undefined,
            strategyRoutingEnabled: Boolean(route[11]),
            strategyRoutingRules: route[12] ? JSON.parse(route[12]) : [],
            bestEffort: Boolean(route[10])
          });
        }

        await db.run(sql`UPDATE endpoint_routes SET targets = ${JSON.stringify(newTargets)} WHERE id = ${route[0]}`);
      }
    }
  }
}


export async function preSeedMigrations() {
  try {
    const tableCheck = await db.run(sql`
      SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'
    `);
    if (tableCheck.rows.length === 0) {
      console.log("[PromptGate Bootstrap] __drizzle_migrations table does not exist. Skipping pre-seeding.");
      return;
    }

    const migrationsToSeed = [
      {
        tag: "0004_bizarre_lightspeed",
        hash: "162b8397e129630992f3eedd9d87909cb35b961cdb944b0fe434964f1f431bac",
        when: 1780365312698,
        check: async () => {
          const info = await db.run(sql`PRAGMA table_info(endpoint_routes)`);
          return info.rows.some((row: any) => row[1] === "fallbackEnabled");
        }
      },
      {
        tag: "0010_unique_warlock",
        hash: "8df48f9d127584ee8a30cb3fe86914a978d0c7f7fddd791cc54f412b8b6aaf04",
        when: 1780841103185,
        check: async () => {
          const info = await db.run(sql`PRAGMA table_info(providers)`);
          return info.rows.some((row: any) => row[1] === "upstreamProxyUrl");
        }
      },
      {
        tag: "0017_session_merge_fix",
        hash: "f85d982f3b25b5836f3b8f35447ebcb9c359cd562663cd9844b676c16c44f4ed",
        when: 1781337600000,
        check: async () => {
          const info = await db.run(sql`PRAGMA table_info(chat_logs)`);
          return info.rows.some((row: any) => row[1] === "responseHash");
        }
      },
      {
        tag: "0018_conversation_root",
        hash: "67fc9456297b5baf231e612eb8d22d0009e9c4a169286b3b1910fde6d40a9e34",
        when: 1781337600001,
        check: async () => {
          const info = await db.run(sql`PRAGMA table_info(chat_logs)`);
          return info.rows.some((row: any) => row[1] === "conversationRootHash");
        }
      },
      {
        tag: "0019_careful_grim_reaper",
        hash: "a535dda62241f71203bffd572839eddb62f7362109f20c113502fa370b65ff30",
        when: 1781255050227,
        check: async () => {
          const info = await db.run(sql`PRAGMA table_info(endpoint_routes)`);
          return info.rows.some((row: any) => row[1] === "fallbackMatchTarget");
        }
      },
      {
        tag: "0020_bouncy_phalanx",
        hash: "745872e92eb5145abd5e18c3b79fe47a1647a142481d989a1d4b41abcd8b659b",
        when: 1781363027942,
        check: async () => {
          const info = await db.run(sql`PRAGMA table_info(chat_logs)`);
          return info.rows.some((row: any) => row[1] === "detectedClient");
        }
      },
      {
        tag: "0021_cheerful_marrow",
        hash: "bb756fd6da97379a31f12879370fcd70f3fc43afea96b24e31fe4f50a10aa5f0",
        when: 1781390847545,
        check: async () => {
          const responseCacheCheck = await db.run(sql`
            SELECT name FROM sqlite_master WHERE type='table' AND name='response_cache'
          `);
          return responseCacheCheck.rows.length > 0;
        }
      },
      {
        tag: "0022_perfect_solo",
        hash: "a59cff2fbba6eb60677c81813619b1bc315cea58f1be2950b0e1160a861f11f1",
        when: 1781413374494,
        check: async () => {
          const endpointRoutesInfo = await db.run(sql`PRAGMA table_info(endpoint_routes)`);
          return endpointRoutesInfo.rows.some((row: any) => row[1] === "schedules");
        }
      },
      {
        tag: "0023_agentic_routing",
        hash: "65b09fdec4226675f3c1564b7893c01a16e0f1b747d507606e9cb061a9464851",
        when: 1781500000000,
        check: async () => {
          const endpointRoutesInfo = await db.run(sql`PRAGMA table_info(endpoint_routes)`);
          const providerModelsInfo = await db.run(sql`PRAGMA table_info(provider_models)`);
          const requestLogsInfo = await db.run(sql`PRAGMA table_info(request_logs)`);
          return (
            endpointRoutesInfo.rows.some((row: any) => row[1] === "agenticRoutingEnabled") &&
            providerModelsInfo.rows.some((row: any) => row[1] === "routingGuideline") &&
            requestLogsInfo.rows.some((row: any) => row[1] === "routingTrace")
          );
        }
      },
      {
        tag: "0026_token_input_limits",
        hash: "6f1bc21f3d4131a44d1b59bcec823d0fd8721ac236c191e07af3fa0fa4a282a8",
        when: 1782139200000,
        check: async () => {
          const info = await db.run(sql`PRAGMA table_info(user_groups)`);
          return info.rows.some((row: any) => row[1] === "maxInputTokens");
        }
      },
      {
        tag: "0027_agentic_routing_cache",
        hash: "21565c2112ca957b49d7b88805c2b8debd05d5bbbf30be0dcb28cb68015fedf0",
        when: 1782142800000,
        check: async () => {
          const tableCheck = await db.run(sql`
            SELECT name FROM sqlite_master WHERE type='table' AND name='agentic_routing_cache'
          `);
          return tableCheck.rows.length > 0;
        }
      },
      {
        tag: "0028_strategy_routing",
        hash: "99b6036b05d72029a3249e02eeba958d3926065e34b1097da0f7bf7a3cd8f8c7",
        when: 1782229200000,
        check: async () => {
          const endpointRoutesInfo = await db.run(sql`PRAGMA table_info(endpoint_routes)`);
          const providerModelsInfo = await db.run(sql`PRAGMA table_info(provider_models)`);
          const agenticCacheCheck = await db.run(sql`
            SELECT name FROM sqlite_master WHERE type='table' AND name='agentic_routing_cache'
          `);
          const endpointColumns = new Set(endpointRoutesInfo.rows.map((row: any) => row[1]));
          const providerModelColumns = new Set(providerModelsInfo.rows.map((row: any) => row[1]));
          return (
            endpointColumns.has("strategyRoutingEnabled") &&
            endpointColumns.has("strategyRoutingRules") &&
            !endpointColumns.has("agenticRoutingEnabled") &&
            !providerModelColumns.has("routingGuideline") &&
            agenticCacheCheck.rows.length === 0
          );
        }
      },
      {
        tag: "0030_broken_blonde_phantom",
        hash: "d4c38ddd5fd01abb69dbc481c78b8abf6c15c6b6e4951e35f8e7b786770ef700",
        when: 1782748656099,
        check: async () => {
          // If hourlyTokenLimit exists, the old runAutoMigrations already added these columns.
          // We seed this migration to prevent Drizzle from crashing on duplicate columns.
          const info = await db.run(sql`PRAGMA table_info(providers)`);
          return info.rows.some((row: any) => row[1] === "hourlyTokenLimit");
        }
      }
    ];

    for (const migration of migrationsToSeed) {
      try {
        const shouldSeed = await migration.check();
        console.log(`[PromptGate Bootstrap] Checking migration ${migration.tag}, shouldSeed: ${shouldSeed}`);
        if (shouldSeed) {
          const existing = await db.run(sql`
            SELECT created_at FROM __drizzle_migrations WHERE hash = ${migration.hash}
          `);
          console.log(`[PromptGate Bootstrap] Existing record for ${migration.tag}: ${existing.rows.length}`);
          if (existing.rows.length === 0) {
            console.log(`[PromptGate Bootstrap] Pre-seeding migration record: ${migration.tag}`);
            await db.run(sql`
              INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${migration.hash}, ${migration.when})
            `);
          } else {
            const currentWhen = Number(existing.rows[0]?.[0] || 0);
            if (currentWhen !== migration.when) {
              console.log(`[PromptGate Bootstrap] Updating pre-seeded migration record: ${migration.tag} (was ${currentWhen}, now ${migration.when})`);
              await db.run(sql`
                UPDATE __drizzle_migrations SET created_at = ${migration.when} WHERE hash = ${migration.hash}
              `);
            }
          }
        }
      } catch (err) {
        console.error(`[PromptGate Bootstrap] Failed to pre-seed migration ${migration.tag}:`, err);
      }
    }
  } catch (err) {
    console.error("[PromptGate Bootstrap] Error in pre-seed migrations helper:", err);
  }
}

export async function isMigrationCompleted(): Promise<boolean> {
  try {
    const migrationsFolder = path.resolve(
      process.cwd(),
      process.cwd().endsWith("server") ? "./drizzle" : "apps/server/drizzle",
    );
    const journalPath = path.join(migrationsFolder, "meta/_journal.json");
    if (!fs.existsSync(journalPath)) {
      return false;
    }
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    const expectedCount = journal.entries?.length || 0;

    const tableCheck = await db.run(sql`
      SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'
    `);
    if (tableCheck.rows.length === 0) {
      return false;
    }

    const countCheck = await db.run(sql`
      SELECT count(*) as count FROM __drizzle_migrations
    `);
    const actualCount = Number(countCheck.rows[0]?.[0] ?? 0);

    return actualCount >= expectedCount;
  } catch (err) {
    console.error("[PromptGate Bootstrap] Error checking migration status:", err);
    return false;
  }
}
