import {
  pgTable,
  text,
  integer,
  boolean,
  doublePrecision,
  bigint,
  unique,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const actionLogs = pgTable(
  "action_logs",
  {
    id: text("id").primaryKey().notNull(),
    timestamp: text("timestamp").notNull(),
    level: text("level").notNull(),
    code: text("code").notNull(),
    serverLine: text("serverLine").notNull(),
    ip: text("ip"),
    params: text("params"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    idx_action_logs_createdat: index("idx_action_logs_createdat").on(
      t.createdAt,
    ),
  }),
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("userId").notNull(),
    name: text("name").notNull(),
    keyHash: text("keyHash").notNull(),
    keyPrefix: text("keyPrefix").notNull(),
    status: text("status").notNull().default("active"),
    rpmLimit: integer("rpmLimit"),
    tpmLimit: integer("tpmLimit"),
    concurrencyLimit: integer("concurrencyLimit").notNull().default(10),
    expiresAt: bigint("expiresAt", { mode: "number" }),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    lastUsedAt: bigint("lastUsedAt", { mode: "number" }),
  },
  (t) => ({
    idx_api_keys_keyhash: index("idx_api_keys_keyhash").on(t.keyHash),
    idx_api_keys_userid: index("idx_api_keys_userid").on(t.userId),
    idx_api_keys_user_status: index("idx_api_keys_user_status").on(
      t.userId,
      t.status,
    ),
  }),
);

export const chatLogs = pgTable(
  "chat_logs",
  {
    id: text("id").primaryKey().notNull(),
    requestId: text("requestId").unique(),
    serverSessionId: text("serverSessionId"),
    clientSessionId: text("clientSessionId"),
    turnId: integer("turnId").notNull().default(0),
    userId: text("userId").notNull(),
    clientName: text("clientName"),
    detectedClient: text("detectedClient"),
    model: text("model"),
    inputText: text("inputText"),
    outputText: text("outputText"),
    responseHash: text("responseHash"),
    conversationRootHash: text("conversationRootHash"),
    inputTokens: integer("inputTokens").default(0),
    outputTokens: integer("outputTokens").default(0),
    latencyMs: integer("latencyMs").default(0),
    ttftMs: integer("ttft_ms"),
    cachedTokens: integer("cached_tokens").default(0),
    isAborted: boolean("is_aborted").default(false),
    status: text("status").default("success"),
    error: text("error"),
    sessionTitle: text("sessionTitle"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    idx_chat_logs_userid: index("idx_chat_logs_userid").on(t.userId),
    idx_chat_logs_serversessionid: index("idx_chat_logs_serversessionid").on(
      t.serverSessionId,
    ),
    idx_chat_logs_createdat: index("idx_chat_logs_createdat").on(t.createdAt),
    idx_chat_logs_user_created: index("idx_chat_logs_user_created").on(
      t.userId,
      t.createdAt,
    ),
    idx_chat_logs_responsehash: index("idx_chat_logs_responsehash").on(
      t.responseHash,
    ),
    idx_chat_logs_rootHash: index("idx_chat_logs_rootHash").on(
      t.conversationRootHash,
    ),
    idx_chat_logs_session_created: index("idx_chat_logs_session_created").on(
      t.serverSessionId,
      t.createdAt,
    ),
    idx_chat_logs_user_client_session: index(
      "idx_chat_logs_user_client_session",
    ).on(t.userId, t.clientSessionId),
  }),
);

export const distillationJobItems = pgTable(
  "distillation_job_items",
  {
    id: text("id").primaryKey().notNull(),
    jobId: text("jobId").notNull(),
    chatLogId: text("chatLogId").notNull(),
    userId: text("userId").notNull(),
    status: text("status").notNull().default("pending"),
    errorMessage: text("errorMessage"),
    processedAt: bigint("processedAt", { mode: "number" }),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    unq_distillation_job_chatlog: unique("unq_distillation_job_chatlog").on(
      t.jobId,
      t.chatLogId,
    ),
    idx_distillation_job_items_job: index("idx_distillation_job_items_job").on(
      t.jobId,
      t.status,
    ),
  }),
);

export const distillationJobs = pgTable(
  "distillation_jobs",
  {
    id: text("id").primaryKey().notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull().default("pending"),
    analysisRouteId: text("analysisRouteId"),
    userIdsFilter: text("userIdsFilter"),
    timeRangeStart: bigint("timeRangeStart", { mode: "number" }),
    timeRangeEnd: bigint("timeRangeEnd", { mode: "number" }),
    maxRecords: integer("maxRecords"),
    totalItems: integer("totalItems").notNull().default(0),
    processedItems: integer("processedItems").notNull().default(0),
    failedItems: integer("failedItems").notNull().default(0),
    errorMessage: text("errorMessage"),
    generationId: text("generationId").notNull(),
    startedAt: bigint("startedAt", { mode: "number" }),
    completedAt: bigint("completedAt", { mode: "number" }),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    idx_distillation_jobs_status: index("idx_distillation_jobs_status").on(
      t.status,
    ),
    idx_distillation_jobs_created: index("idx_distillation_jobs_created").on(
      t.createdAt,
    ),
  }),
);

export const distillationLearnedRecords = pgTable(
  "distillation_learned_records",
  {
    chatLogId: text("chatLogId").primaryKey().notNull(),
    jobId: text("jobId").notNull(),
    generationId: text("generationId").notNull(),
    learnedAt: bigint("learnedAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    idx_distillation_learned_records_jobid: index(
      "idx_distillation_learned_records_jobid",
    ).on(t.jobId),
  }),
);

export const distillationRoutingProposals = pgTable(
  "distillation_routing_proposals",
  {
    id: text("id").primaryKey().notNull(),
    jobId: text("jobId").notNull(),
    chatLogId: text("chatLogId"),
    sourceUserId: text("sourceUserId"),
    status: text("status").notNull().default("draft"),
    payload: text("payload").notNull(),
    validationResult: text("validationResult"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    idx_distillation_proposals_status: index(
      "idx_distillation_proposals_status",
    ).on(t.status),
    idx_distillation_proposals_jobid: index(
      "idx_distillation_proposals_jobid",
    ).on(t.jobId),
  }),
);

export const distillationSignalVersions = pgTable(
  "distillation_signal_versions",
  {
    id: text("id").primaryKey().notNull(),
    versionLabel: text("versionLabel").notNull(),
    weightOverrides: text("weightOverrides").notNull(),
    boundaryRules: text("boundaryRules").notNull(),
    proposalIds: text("proposalIds").notNull(),
    isActive: boolean("isActive").notNull().default(false),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    idx_distillation_signal_versions_is_active: index(
      "idx_distillation_signal_versions_is_active",
    ).on(t.isActive),
  }),
);

export const distillationSkillPackages = pgTable(
  "distillation_skill_packages",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("userId").notNull(),
    username: text("username").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    files: text("files").notNull(),
    sourceRecordCount: integer("sourceRecordCount").notNull().default(0),
    jobId: text("jobId"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    idx_distillation_skill_user: index("idx_distillation_skill_user").on(
      t.userId,
      t.version,
    ),
  }),
);

export const endpointRoutes = pgTable(
  "endpoint_routes",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").default(""),
    endpointId: text("endpointId").notNull(),
    subdomainId: text("subdomainId"),
    providerId: text("providerId").notNull(),
    providerProtocol: text("providerProtocol").notNull().default("openai"),
    modelId: text("modelId").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    promptPolicyId: text("promptPolicyId"),
    fallbackEnabled: boolean("fallbackEnabled").notNull().default(false),
    retryCount: integer("retryCount").notNull().default(3),
    fallbackProviderId: text("fallbackProviderId"),
    fallbackProviderProtocol: text("fallbackProviderProtocol"),
    fallbackModelId: text("fallbackModelId"),
    fallbackPromptPolicyId: text("fallbackPromptPolicyId"),
    fallbackMatchTarget: boolean("fallbackMatchTarget").notNull().default(false),
    fallbackStrategyRoutingEnabled: boolean("fallbackStrategyRoutingEnabled")
      .notNull()
      .default(false),
    fallbackStrategyRoutingRules: text("fallbackStrategyRoutingRules"),
    strategyRoutingEnabled: boolean("strategyRoutingEnabled")
      .notNull()
      .default(false),
    strategyRoutingRules: text("strategyRoutingRules"),
    routingMode: text("routingMode").notNull().default("strategy"),
    targets: text("targets"),
    weight: integer("weight").notNull().default(1),
    priority: integer("priority").notNull().default(0),
    status: text("status").default("active"),
    allowClientModel: boolean("allowClientModel").notNull().default(false),
    schedules: text("schedules"),
    ipWhitelist: text("ipWhitelist"),
    timeoutEjectEnabled: boolean("timeoutEjectEnabled").notNull().default(false),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    idx_endpoint_routes_endpointid: index("idx_endpoint_routes_endpointid").on(
      t.endpointId,
    ),
    idx_endpoint_routes_subdomainid: index(
      "idx_endpoint_routes_subdomainid",
    ).on(t.subdomainId),
    idx_endpoint_routes_endpoint_status: index(
      "idx_endpoint_routes_endpoint_status",
    ).on(t.endpointId, t.status),
  }),
);

export const endpoints = pgTable(
  "endpoints",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("userId").notNull(),
    name: text("name").default(""),
    path: text("path").notNull(),
    virtualModelAlias: text("virtualModelAlias"),
    loadBalanceMode: text("loadBalanceMode").default("failover"),
    incomingProtocol: text("incomingProtocol").notNull().default("openai"),
    enabled: boolean("enabled").notNull().default(true),
    timeoutMs: integer("timeoutMs").notNull().default(0),
    queueTimeoutMs: integer("queueTimeoutMs").notNull().default(0),
    maxBodyMb: integer("maxBodyMb").notNull().default(0),
    status: text("status").default("active"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
  },
  (table) => ({
    endpointUniqueIdx: unique("endpoint_unique_idx").on(
      table.name,
      table.path,
      table.incomingProtocol,
    ),
  }),
);

export const inviteCodes = pgTable(
  "invite_codes",
  {
    id: text("id").primaryKey().notNull(),
    codeHash: text("codeHash").notNull(),
    codePrefix: text("codePrefix").notNull(),
    maxUses: integer("maxUses").notNull().default(1),
    usedCount: integer("usedCount").notNull().default(0),
    expiresAt: bigint("expiresAt", { mode: "number" }),
    status: text("status").notNull().default("active"),
    createdBy: text("createdBy").notNull(),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    idx_invite_codes_codehash: index("idx_invite_codes_codehash").on(t.codeHash),
  }),
);

export const openapiKeys = pgTable(
  "openapi_keys",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("userId").notNull(),
    name: text("name").notNull(),
    keyHash: text("keyHash").notNull(),
    keyPrefix: text("keyPrefix").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    lastUsedAt: bigint("lastUsedAt", { mode: "number" }),
  },
  (t) => ({
    idx_openapi_keys_keyhash: index("idx_openapi_keys_keyhash").on(t.keyHash),
    idx_openapi_keys_userid: index("idx_openapi_keys_userid").on(t.userId),
  }),
);

export const promptInjectionRecords = pgTable(
  "prompt_injection_records",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("userId").notNull(),
    apiKeyId: text("apiKeyId").notNull(),
    endpointId: text("endpointId"),
    subdomainId: text("subdomainId"),
    promptPolicyId: text("promptPolicyId").notNull(),
    conversationId: text("conversationId").notNull(),
    contentHash: text("contentHash").notNull(),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    idx_prompt_injection_records_conv_policy: index(
      "idx_prompt_injection_records_conv_policy",
    ).on(t.conversationId, t.promptPolicyId),
    idx_prompt_injection_records_user_created: index(
      "idx_prompt_injection_records_user_created",
    ).on(t.userId, t.createdAt),
  }),
);

export const promptPolicies = pgTable("prompt_policies", {
  id: text("id").primaryKey().notNull(),
  userId: text("userId").notNull(),
  name: text("name").notNull(),
  protocol: text("protocol").notNull().default("openai"),
  injectPosition: text("injectPosition").notNull().default("append_system"),
  injectMode: text("injectMode").notNull().default("every_request"),
  conversationKeySource: text("conversationKeySource").default("header"),
  conversationKeyName: text("conversationKeyName").default("X-Conversation-Id"),
  fallbackMode: text("fallbackMode").default("treat_as_new"),
  content: text("content").notNull(),
  version: integer("version").notNull().default(1),
  description: text("description"),
  enabled: boolean("enabled").default(true),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
});

export const providerApiKeys = pgTable(
  "provider_api_keys",
  {
    id: text("id").primaryKey().notNull(),
    providerId: text("providerId").notNull(),
    keyEncrypted: text("keyEncrypted").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
    lastUsedAt: bigint("lastUsedAt", { mode: "number" }),
  },
  (t) => ({
    idx_provider_api_keys_provider_status: index(
      "idx_provider_api_keys_provider_status",
    ).on(t.providerId, t.status),
    idx_provider_api_keys_providerid: index(
      "idx_provider_api_keys_providerid",
    ).on(t.providerId),
  }),
);

export const providerModels = pgTable(
  "provider_models",
  {
    id: text("id").primaryKey().notNull(),
    providerId: text("providerId").notNull(),
    modelId: text("modelId").notNull(),
    displayName: text("displayName").notNull(),
    rawJson: text("rawJson"),
    enabled: boolean("enabled").notNull().default(true),
    contextWindowTokens: integer("contextWindowTokens"),
    maxOutputTokens: integer("maxOutputTokens"),
    inputTokenPricePerM: doublePrecision("inputTokenPricePerM"),
    outputTokenPricePerM: doublePrecision("outputTokenPricePerM"),
    tokenizerRepo: text("tokenizerRepo"),
    alias: text("alias"),
    active: boolean("active").notNull().default(true),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    unq_provider_model: unique("unq_provider_model").on(
      t.providerId,
      t.modelId,
    ),
  }),
);

export const providerTestSessions = pgTable("provider_test_sessions", {
  id: text("id").primaryKey().notNull(),
  protocol: text("protocol").notNull().default("openai"),
  baseUrlHash: text("baseUrlHash").notNull(),
  apiKeyHash: text("apiKeyHash"),
  models: text("models").notNull(),
  expiresAt: bigint("expiresAt", { mode: "number" }).notNull(),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
});

export const providers = pgTable("providers", {
  id: text("id").primaryKey().notNull(),
  name: text("name").notNull(),
  openaiBaseUrl: text("openaiBaseUrl"),
  anthropicBaseUrl: text("anthropicBaseUrl"),
  concurrencyLimit: integer("concurrencyLimit").notNull().default(10),
  timeoutMs: integer("timeoutMs").notNull().default(30000),
  streamTimeoutMs: integer("streamTimeoutMs").notNull().default(300000),
  maxOutputTokens: integer("maxOutputTokens").notNull().default(0),
  hourlyTokenLimit: integer("hourlyTokenLimit").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  manualModels: text("manualModels"),
  lastTestAt: bigint("lastTestAt", { mode: "number" }),
  lastTestStatus: text("lastTestStatus"),
  lastTestMessage: text("lastTestMessage"),
  upstreamProxyUrl: text("upstreamProxyUrl"),
  weightProxyUrl: text("weightProxyUrl"),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
});

export const requestLogs = pgTable(
  "request_logs",
  {
    id: text("id").primaryKey().notNull(),
    requestId: text("requestId").notNull(),
    userId: text("userId").notNull(),
    apiKeyId: text("apiKeyId"),
    providerId: text("providerId"),
    providerApiKeyId: text("providerApiKeyId"),
    endpointId: text("endpointId"),
    subdomainId: text("subdomainId"),
    protocol: text("protocol"),
    model: text("model"),
    statusCode: integer("statusCode"),
    inputTokens: integer("inputTokens").default(0),
    outputTokens: integer("outputTokens").default(0),
    cacheReadTokens: integer("cacheReadTokens").default(0),
    cacheWriteTokens: integer("cacheWriteTokens").default(0),
    totalTokens: integer("totalTokens").default(0),
    latencyMs: integer("latencyMs").default(0),
    ttftMs: integer("ttftMs").default(0),
    streaming: boolean("streaming").default(false),
    usageStatus: text("usageStatus"),
    errorCode: text("errorCode"),
    errorMessage: text("errorMessage"),
    ipAddress: text("ipAddress"),
    cost: doublePrecision("cost"),
    routingTrace: text("routingTrace"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    idx_request_logs_createdat: index("idx_request_logs_createdat").on(
      t.createdAt,
    ),
    idx_request_logs_user_created: index("idx_request_logs_user_created").on(
      t.userId,
      t.createdAt,
    ),
    idx_request_logs_provider_created: index(
      "idx_request_logs_provider_created",
    ).on(t.providerId, t.createdAt),
    idx_request_logs_model_created: index("idx_request_logs_model_created").on(
      t.model,
      t.createdAt,
    ),
    idx_request_logs_endpoint_created: index(
      "idx_request_logs_endpoint_created",
    ).on(t.endpointId, t.createdAt),
    idx_request_logs_subdomain_created: index(
      "idx_request_logs_subdomain_created",
    ).on(t.subdomainId, t.createdAt),
    idx_request_logs_api_key_created: index(
      "idx_request_logs_api_key_created",
    ).on(t.apiKeyId, t.createdAt),
  }),
);

export const responseCache = pgTable(
  "response_cache",
  {
    id: text("id").primaryKey().notNull(),
    inputHash: text("inputHash").notNull(),
    inputText: text("inputText").notNull(),
    responseText: text("responseText").notNull(),
    model: text("model"),
    sourceLogId: text("sourceLogId"),
    hitCount: integer("hitCount").notNull().default(0),
    lastHitAt: bigint("lastHitAt", { mode: "number" }),
    createdBy: text("createdBy"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    unq_response_cache_inputhash: unique("unq_response_cache_inputhash").on(
      t.inputHash,
    ),
    idx_response_cache_inputhash: index("idx_response_cache_inputhash").on(
      t.inputHash,
    ),
    idx_response_cache_createdat: index("idx_response_cache_createdat").on(
      t.createdAt,
    ),
  }),
);

export const routeAuthorizations = pgTable(
  "route_authorizations",
  {
    id: text("id").primaryKey().notNull(),
    routeId: text("routeId").notNull(),
    userId: text("userId"),
    groupId: text("groupId"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    unq_route_user: unique("unq_route_user").on(t.routeId, t.userId),
    unq_route_group: unique("unq_route_group").on(t.routeId, t.groupId),
    idx_route_authorizations_userid: index(
      "idx_route_authorizations_userid",
    ).on(t.userId),
    idx_route_authorizations_groupid: index(
      "idx_route_authorizations_groupid",
    ).on(t.groupId),
  }),
);

export const subdomains = pgTable("subdomains", {
  id: text("id").primaryKey().notNull(),
  userId: text("userId").notNull(),
  name: text("name").notNull(),
  hostname: text("hostname").notNull().unique(),
  enabled: boolean("enabled").notNull().default(true),
  description: text("description"),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
});

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey().notNull(),
  value: text("value").notNull(),
  description: text("description"),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
});

export const userGroupMembers = pgTable(
  "user_group_members",
  {
    id: text("id").primaryKey().notNull(),
    groupId: text("groupId").notNull(),
    userId: text("userId").notNull(),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    unq_group_user: unique("unq_group_user").on(t.groupId, t.userId),
    unq_user_one_group: uniqueIndex("unq_user_one_group").on(t.userId),
  }),
);

export const userGroups = pgTable("user_groups", {
  id: text("id").primaryKey().notNull(),
  name: text("name").notNull().unique(),
  description: text("description"),
  isDefault: boolean("isDefault").notNull().default(false),
  maxInputTokens: integer("maxInputTokens").notNull().default(0),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
});

export const userRouteOverrides = pgTable(
  "user_route_overrides",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("userId").notNull(),
    routeId: text("routeId").notNull(),
    modelId: text("modelId"),
    useClientModel: boolean("useClientModel").notNull().default(false),
    strategyRoutingRules: text("strategyRoutingRules"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
  },
  (t) => ({
    unq_user_route: unique("unq_user_route").on(t.userId, t.routeId),
  }),
);

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey().notNull(),
    username: text("username").notNull().unique(),
    passwordHash: text("passwordHash").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    maxInputTokensOverride: integer("maxInputTokensOverride"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
    lastLoginAt: bigint("lastLoginAt", { mode: "number" }),
  },
  (t) => ({
    idx_users_status: index("idx_users_status").on(t.status),
  }),
);
