import { db, initDb, getDbDriver, client } from "../db";
import { sql, eq, inArray } from "drizzle-orm";
import { userGroupMembers, userGroups } from "../db/schema";
import path from "path";
import fs from "fs";

export async function tableExists(tableName: string): Promise<boolean> {
  try {
    const driver = getDbDriver();
    if (driver === "postgres") {
      const result = await (client as any).query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1;",
        [tableName],
      );
      return (result?.rows?.length ?? 0) > 0;
    }
    const result = await db.run(sql`
      SELECT name FROM sqlite_master WHERE type='table' AND name=${tableName}
    `);
    return result.rows.length > 0;
  } catch {
    return false;
  }
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
  await addColumnIfMissing("endpoint_routes", "routingMode", "ALTER TABLE endpoint_routes ADD COLUMN routingMode text DEFAULT 'strategy' NOT NULL");
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

export interface IndexSpec {
  table: string;
  name: string;
  sqliteColumns: string;
  pgColumns: string;
  unique?: boolean;
}

export async function applyIndexSpec(spec: IndexSpec): Promise<void> {
  if (!(await tableExists(spec.table))) return;

  const driver = getDbDriver();
  if (driver === "postgres") {
    const concurrentSql = spec.unique
      ? `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${spec.name} ON "${spec.table}" (${spec.pgColumns})`
      : `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${spec.name} ON "${spec.table}" (${spec.pgColumns})`;
    const fallbackSql = spec.unique
      ? `CREATE UNIQUE INDEX IF NOT EXISTS ${spec.name} ON "${spec.table}" (${spec.pgColumns})`
      : `CREATE INDEX IF NOT EXISTS ${spec.name} ON "${spec.table}" (${spec.pgColumns})`;

    try {
      // client.query executes outside of any transaction block on the pg pool
      await (client as any).query(concurrentSql);
    } catch (concurrentErr: any) {
      console.warn(
        `[PromptGate] Concurrent index creation for ${spec.name} on ${spec.table} failed (${concurrentErr?.message || concurrentErr}). Falling back to non-concurrent CREATE INDEX.`,
      );
      try {
        await (client as any).query(fallbackSql);
      } catch (fallbackErr: any) {
        console.warn(
          `[PromptGate] Failed to create index ${spec.name} on ${spec.table}:`,
          fallbackErr?.message || fallbackErr,
        );
      }
    }
  } else {
    const sqliteSql = spec.unique
      ? `CREATE UNIQUE INDEX IF NOT EXISTS ${spec.name} ON ${spec.table} (${spec.sqliteColumns})`
      : `CREATE INDEX IF NOT EXISTS ${spec.name} ON ${spec.table} (${spec.sqliteColumns})`;

    try {
      await (db as any).run(sql.raw(sqliteSql));
    } catch (err: any) {
      console.warn(
        `[PromptGate] Failed to create index ${spec.name} on ${spec.table}:`,
        err?.message || err,
      );
    }
  }
}

export const ANALYTICS_INDEXES: IndexSpec[] = [
  {
    table: "request_logs",
    name: "idx_request_logs_createdat",
    sqliteColumns: "createdAt",
    pgColumns: '"createdAt"',
  },
  {
    table: "request_logs",
    name: "idx_request_logs_user_created",
    sqliteColumns: "userId, createdAt",
    pgColumns: '"userId", "createdAt"',
  },
  {
    table: "request_logs",
    name: "idx_request_logs_provider_created",
    sqliteColumns: "providerId, createdAt",
    pgColumns: '"providerId", "createdAt"',
  },
  {
    table: "request_logs",
    name: "idx_request_logs_model_created",
    sqliteColumns: "model, createdAt",
    pgColumns: 'model, "createdAt"',
  },
  {
    table: "request_logs",
    name: "idx_request_logs_endpoint_created",
    sqliteColumns: "endpointId, createdAt",
    pgColumns: '"endpointId", "createdAt"',
  },
  {
    table: "request_logs",
    name: "idx_request_logs_subdomain_created",
    sqliteColumns: "subdomainId, createdAt",
    pgColumns: '"subdomainId", "createdAt"',
  },
  {
    table: "request_logs",
    name: "idx_request_logs_api_key_created",
    sqliteColumns: "apiKeyId, createdAt",
    pgColumns: '"apiKeyId", "createdAt"',
  },
];

export async function ensureAnalyticsIndexes(): Promise<void> {
  for (const spec of ANALYTICS_INDEXES) {
    await applyIndexSpec(spec);
  }
}

export const HOT_PATH_INDEXES: IndexSpec[] = [
  // 1. action_logs: cleanup lt(createdAt) and time ordering
  {
    table: "action_logs",
    name: "idx_action_logs_createdat",
    sqliteColumns: "createdAt",
    pgColumns: '"createdAt"',
  },
  // 2. api_keys: gateway auth every request (critical), user lookups, and status filters
  {
    table: "api_keys",
    name: "idx_api_keys_keyhash",
    sqliteColumns: "keyHash",
    pgColumns: '"keyHash"',
  },
  {
    table: "api_keys",
    name: "idx_api_keys_userid",
    sqliteColumns: "userId",
    pgColumns: '"userId"',
  },
  {
    table: "api_keys",
    name: "idx_api_keys_user_status",
    sqliteColumns: "userId, status",
    pgColumns: '"userId", status',
  },
  // 3. invite_codes: signup / auth lookup by codeHash
  {
    table: "invite_codes",
    name: "idx_invite_codes_codehash",
    sqliteColumns: "codeHash",
    pgColumns: '"codeHash"',
  },
  // 4. openapi_keys: key authentication by hash and user listings
  {
    table: "openapi_keys",
    name: "idx_openapi_keys_keyhash",
    sqliteColumns: "keyHash",
    pgColumns: '"keyHash"',
  },
  {
    table: "openapi_keys",
    name: "idx_openapi_keys_userid",
    sqliteColumns: "userId",
    pgColumns: '"userId"',
  },
  // 5. provider_api_keys: provider gateway routing with active status and provider queries
  {
    table: "provider_api_keys",
    name: "idx_provider_api_keys_provider_status",
    sqliteColumns: "providerId, status",
    pgColumns: '"providerId", status',
  },
  {
    table: "provider_api_keys",
    name: "idx_provider_api_keys_providerid",
    sqliteColumns: "providerId",
    pgColumns: '"providerId"',
  },
  // 6. provider_models: unq_provider_model(providerId, modelId) already covers providerId prefix; skip redundant index per rule 4.
  // 7. endpoint_routes: gateway routing (endpointId, status), endpoint FK deletes, and subdomain queries
  {
    table: "endpoint_routes",
    name: "idx_endpoint_routes_endpointid",
    sqliteColumns: "endpointId",
    pgColumns: '"endpointId"',
  },
  {
    table: "endpoint_routes",
    name: "idx_endpoint_routes_subdomainid",
    sqliteColumns: "subdomainId",
    pgColumns: '"subdomainId"',
  },
  {
    table: "endpoint_routes",
    name: "idx_endpoint_routes_endpoint_status",
    sqliteColumns: "endpointId, status",
    pgColumns: '"endpointId", status',
  },
  // 8. user_group_members: unq_user_one_group on userId ensures exclusive membership; skip redundant non-unique index.
  // 9. route_authorizations: route auth lookups and group deletes/filters
  {
    table: "route_authorizations",
    name: "idx_route_authorizations_userid",
    sqliteColumns: "userId",
    pgColumns: '"userId"',
  },
  {
    table: "route_authorizations",
    name: "idx_route_authorizations_groupid",
    sqliteColumns: "groupId",
    pgColumns: '"groupId"',
  },
  // 10. chat_logs: turn ordering within session and user/clientSession resolution
  {
    table: "chat_logs",
    name: "idx_chat_logs_userid",
    sqliteColumns: "userId",
    pgColumns: '"userId"',
  },
  {
    table: "chat_logs",
    name: "idx_chat_logs_serversessionid",
    sqliteColumns: "serverSessionId",
    pgColumns: '"serverSessionId"',
  },
  {
    table: "chat_logs",
    name: "idx_chat_logs_createdat",
    sqliteColumns: "createdAt",
    pgColumns: '"createdAt"',
  },
  {
    table: "chat_logs",
    name: "idx_chat_logs_user_created",
    sqliteColumns: "userId, createdAt",
    pgColumns: '"userId", "createdAt"',
  },
  {
    table: "chat_logs",
    name: "idx_chat_logs_responsehash",
    sqliteColumns: "responseHash",
    pgColumns: '"responseHash"',
  },
  {
    table: "chat_logs",
    name: "idx_chat_logs_session_created",
    sqliteColumns: "serverSessionId, createdAt",
    pgColumns: '"serverSessionId", "createdAt"',
  },
  {
    table: "chat_logs",
    name: "idx_chat_logs_user_client_session",
    sqliteColumns: "userId, clientSessionId",
    pgColumns: '"userId", "clientSessionId"',
  },
  // 12. distillation_learned_records: filter/manage records by jobId
  {
    table: "distillation_learned_records",
    name: "idx_distillation_learned_records_jobid",
    sqliteColumns: "jobId",
    pgColumns: '"jobId"',
  },
  // 13. distillation_routing_proposals: filter proposals by jobId
  {
    table: "distillation_routing_proposals",
    name: "idx_distillation_proposals_jobid",
    sqliteColumns: "jobId",
    pgColumns: '"jobId"',
  },
  // 14. distillation_signal_versions: active version lookup in gateway routing overlay
  {
    table: "distillation_signal_versions",
    name: "idx_distillation_signal_versions_is_active",
    sqliteColumns: "isActive",
    pgColumns: '"isActive"',
  },
  // 15. response_cache: admin cache list sorted by createdAt
  {
    table: "response_cache",
    name: "idx_response_cache_createdat",
    sqliteColumns: "createdAt",
    pgColumns: '"createdAt"',
  },
  // 16. users: user status filtering (active / not deleted)
  {
    table: "users",
    name: "idx_users_status",
    sqliteColumns: "status",
    pgColumns: "status",
  },
  // 17. prompt_injection_records: deduplication lookup during gateway injection
  {
    table: "prompt_injection_records",
    name: "idx_prompt_injection_records_conv_policy",
    sqliteColumns: "conversationId, promptPolicyId",
    pgColumns: '"conversationId", "promptPolicyId"',
  },
  {
    table: "prompt_injection_records",
    name: "idx_prompt_injection_records_user_created",
    sqliteColumns: "userId, createdAt",
    pgColumns: '"userId", "createdAt"',
  },
];

export async function ensureHotPathIndexes(): Promise<void> {
  for (const spec of HOT_PATH_INDEXES) {
    await applyIndexSpec(spec);
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

/** Additive P0 column: route selected models through the managed OpenCode sidecar. */
export async function ensureUseOpencodeProxyColumn() {
  if (!(await tableExists("provider_models"))) return;
  const driver = getDbDriver();
  if (driver === "postgres") {
    try {
      await (client as any).query(
        `ALTER TABLE "provider_models" ADD COLUMN IF NOT EXISTS "useOpencodeProxy" boolean DEFAULT false NOT NULL`,
      );
    } catch (err: any) {
      if (!String(err?.message || "").includes("already exists")) {
        throw err;
      }
    }
    return;
  }
  await addColumnIfMissing(
    "provider_models",
    "useOpencodeProxy",
    "ALTER TABLE provider_models ADD COLUMN useOpencodeProxy integer DEFAULT 0 NOT NULL",
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
  await addColumnIfMissing(
    "endpoint_routes",
    "timeoutEjectEnabled",
    "ALTER TABLE endpoint_routes ADD COLUMN timeoutEjectEnabled integer DEFAULT 0 NOT NULL",
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

/**
 * Product rule: A user may belong to at most one user group at a time.
 * On boot, repairs any multi-membership pollution:
 * Keep-which-group heuristic:
 * 1. Prefer a membership whose group has isDefault === false over the default group.
 * 2. If still multiple, keep the row with the latest createdAt.
 * 3. If still tied, keep the lexicographically smallest membership id (stable).
 * 4. Delete all other membership rows for that user.
 */
export async function ensureExclusiveUserGroupMembership(): Promise<{ repairedRows: number; repairedUsers: number }> {
  try {
    // Check whether tables are ready before querying
    await db.select({ id: userGroupMembers.id }).from(userGroupMembers).limit(1);
    await db.select({ id: userGroups.id }).from(userGroups).limit(1);
  } catch {
    return { repairedRows: 0, repairedUsers: 0 };
  }

  const allMemberships = await db
    .select({
      id: userGroupMembers.id,
      userId: userGroupMembers.userId,
      groupId: userGroupMembers.groupId,
      createdAt: userGroupMembers.createdAt,
      isDefault: userGroups.isDefault,
    })
    .from(userGroupMembers)
    .leftJoin(userGroups, eq(userGroupMembers.groupId, userGroups.id));

  const userMap = new Map<string, typeof allMemberships>();
  for (const row of allMemberships) {
    const list = userMap.get(row.userId) || [];
    list.push(row);
    userMap.set(row.userId, list);
  }

  const getTime = (val: any): number => {
    if (val instanceof Date) return val.getTime();
    if (typeof val === "number") return val;
    if (typeof val === "string") {
      const parsed = new Date(val).getTime();
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  };

  const isDefaultGroup = (val: any): boolean => {
    return val === true || val === 1 || val === "true";
  };

  const idsToDelete: string[] = [];
  let repairedUsersCount = 0;

  for (const [, userMemberships] of userMap.entries()) {
    if (userMemberships.length <= 1) continue;

    userMemberships.sort((a, b) => {
      // 1. Prefer custom group (isDefault === false) over default group (isDefault === true)
      const aIsDefault = isDefaultGroup(a.isDefault);
      const bIsDefault = isDefaultGroup(b.isDefault);
      if (aIsDefault !== bIsDefault) {
        return aIsDefault ? 1 : -1;
      }

      // 2. If still multiple, keep the row with latest createdAt
      const timeA = getTime(a.createdAt);
      const timeB = getTime(b.createdAt);
      if (timeA !== timeB) {
        return timeB - timeA;
      }

      // 3. If still tied, keep lexicographically smallest membership id (stable)
      return a.id.localeCompare(b.id);
    });

    const toDelete = userMemberships.slice(1);
    for (const row of toDelete) {
      idsToDelete.push(row.id);
    }
    repairedUsersCount++;
  }

  if (idsToDelete.length > 0) {
    for (let i = 0; i < idsToDelete.length; i += 500) {
      const chunk = idsToDelete.slice(i, i + 500);
      await db.delete(userGroupMembers).where(inArray(userGroupMembers.id, chunk));
    }
    console.log(`[PromptGate] Repaired ${idsToDelete.length} exclusive group membership(s) for ${repairedUsersCount} user(s).`);
  }

  // Safe unique index creation after cleanup
  try {
    const driver = getDbDriver();
    if (driver === "postgres") {
      await (db as any).run(sql.raw('CREATE UNIQUE INDEX IF NOT EXISTS unq_user_one_group ON user_group_members ("userId")'));
    } else {
      await (db as any).run(sql.raw('CREATE UNIQUE INDEX IF NOT EXISTS unq_user_one_group ON user_group_members (userId)'));
    }
  } catch (err: any) {
    // Non-fatal if index creation fails on specific engine
  }

  return { repairedRows: idsToDelete.length, repairedUsers: repairedUsersCount };
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
    await initDb();
    const driver = getDbDriver();

    if (driver === "postgres") {
      const migrationsFolder = path.resolve(
        process.cwd(),
        process.cwd().endsWith("server") ? "./drizzle/pg" : "apps/server/drizzle/pg",
      );
      const journalPath = path.join(migrationsFolder, "meta/_journal.json");
      if (!fs.existsSync(journalPath)) {
        return false;
      }
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      const expectedCount = journal.entries?.length || 0;

      const res = await (client as any).query(
        "SELECT count(*) as count FROM drizzle.__drizzle_migrations;"
      ).catch(() => ({ rows: [{ count: 0 }] }));
      const actualCount = Number(res.rows[0]?.count ?? 0);

      return actualCount >= expectedCount;
    }

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
