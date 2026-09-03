import { sqliteTable, text, integer, unique, real, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("passwordHash").notNull(),
  role: text("role").notNull(), // 'admin' | 'user'
  status: text("status").notNull().default("active"), // 'active' | 'disabled'
  maxInputTokensOverride: integer("maxInputTokensOverride"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  lastLoginAt: integer("lastLoginAt", { mode: "timestamp" }),
});

export const inviteCodes = sqliteTable("invite_codes", {
  id: text("id").primaryKey(),
  codeHash: text("codeHash").notNull(),
  codePrefix: text("codePrefix").notNull(),
  maxUses: integer("maxUses").notNull().default(1),
  usedCount: integer("usedCount").notNull().default(0),
  expiresAt: integer("expiresAt", { mode: "timestamp" }),
  status: text("status").notNull().default("active"),
  createdBy: text("createdBy").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  name: text("name").notNull(),
  keyHash: text("keyHash").notNull(),
  keyPrefix: text("keyPrefix").notNull(),
  status: text("status").notNull().default("active"),
  rpmLimit: integer("rpmLimit"),
  tpmLimit: integer("tpmLimit"),
  concurrencyLimit: integer("concurrencyLimit").notNull().default(10),
  expiresAt: integer("expiresAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  lastUsedAt: integer("lastUsedAt", { mode: "timestamp" }),
});

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  openaiBaseUrl: text("openaiBaseUrl"),
  anthropicBaseUrl: text("anthropicBaseUrl"),
  concurrencyLimit: integer("concurrencyLimit").notNull().default(10),
  timeoutMs: integer("timeoutMs").notNull().default(30000),
  streamTimeoutMs: integer("streamTimeoutMs").notNull().default(300000),
  maxOutputTokens: integer("maxOutputTokens").notNull().default(0),
  hourlyTokenLimit: integer("hourlyTokenLimit").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  manualModels: text("manualModels"), // JSON string
  lastTestAt: integer("lastTestAt", { mode: "timestamp" }),
  lastTestStatus: text("lastTestStatus"), // 'success' | 'failed'
  lastTestMessage: text("lastTestMessage"),
  upstreamProxyUrl: text("upstreamProxyUrl"),
  weightProxyUrl: text("weightProxyUrl"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const providerApiKeys = sqliteTable("provider_api_keys", {
  id: text("id").primaryKey(),
  providerId: text("providerId").notNull(),
  keyEncrypted: text("keyEncrypted").notNull(),
  status: text("status").notNull().default("active"), // 'active' | 'exhausted'
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  lastUsedAt: integer("lastUsedAt", { mode: "timestamp" }),
});

export const providerModels = sqliteTable("provider_models", {
  id: text("id").primaryKey(),
  providerId: text("providerId").notNull(),
  modelId: text("modelId").notNull(),
  displayName: text("displayName").notNull(),
  rawJson: text("rawJson"), // JSON string
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Total context window (input+output budget) for strategy/long_context routing. Independent of maxOutputTokens. */
  contextWindowTokens: integer("contextWindowTokens"),
  /** Caps client max_tokens / max_completion_tokens only; never used as context window. */
  maxOutputTokens: integer("maxOutputTokens"),
  inputTokenPricePerM: real("inputTokenPricePerM"),
  outputTokenPricePerM: real("outputTokenPricePerM"),
  tokenizerRepo: text("tokenizerRepo"),
  alias: text("alias"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
}, (t) => ({
  unq_provider_model: unique("unq_provider_model").on(t.providerId, t.modelId)
}));

export const providerTestSessions = sqliteTable("provider_test_sessions", {
  id: text("id").primaryKey(),
  protocol: text("protocol").notNull().default("openai"),
  baseUrlHash: text("baseUrlHash").notNull(),
  apiKeyHash: text("apiKeyHash"),
  models: text("models").notNull(), // JSON string of models array
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export const subdomains = sqliteTable("subdomains", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  name: text("name").notNull(), // first label; identity is hostname, not name
  hostname: text("hostname").notNull().unique(), // e.g. "code-frontend.localhost"
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  description: text("description"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const endpoints = sqliteTable("endpoints", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  name: text("name").default(""),
  path: text("path").notNull(),
  virtualModelAlias: text("virtualModelAlias"), // matched with model in request body, optional
  loadBalanceMode: text("loadBalanceMode").default("failover"),
  incomingProtocol: text("incomingProtocol").notNull().default("openai"), // 'openai' | 'anthropic'
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  timeoutMs: integer("timeoutMs").notNull().default(0),
  queueTimeoutMs: integer("queueTimeoutMs").notNull().default(0),
  maxBodyMb: integer("maxBodyMb").notNull().default(0), // 0 means no limit
  status: text("status").default("active"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (table) => {
  return {
    endpointUniqueIdx: unique("endpoint_unique_idx").on(table.name, table.path, table.incomingProtocol),
  };
});

export const endpointRoutes = sqliteTable("endpoint_routes", {
  id: text("id").primaryKey(),
  name: text("name").default(""),
  endpointId: text("endpointId").notNull(),
  subdomainId: text("subdomainId"),
  providerId: text("providerId").notNull(),
  providerProtocol: text("providerProtocol").notNull().default("openai"), // 'openai' | 'anthropic'
  modelId: text("modelId").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  promptPolicyId: text("promptPolicyId"),
  fallbackEnabled: integer("fallbackEnabled", { mode: "boolean" }).notNull().default(false),
  retryCount: integer("retryCount").notNull().default(3),
  fallbackProviderId: text("fallbackProviderId"),
  fallbackProviderProtocol: text("fallbackProviderProtocol"),
  fallbackModelId: text("fallbackModelId"),
  fallbackPromptPolicyId: text("fallbackPromptPolicyId"),
  fallbackMatchTarget: integer("fallbackMatchTarget", { mode: "boolean" }).notNull().default(false),
  fallbackStrategyRoutingEnabled: integer("fallbackStrategyRoutingEnabled", { mode: "boolean" }).notNull().default(false),
  fallbackStrategyRoutingRules: text("fallbackStrategyRoutingRules"),
  strategyRoutingEnabled: integer("strategyRoutingEnabled", { mode: "boolean" }).notNull().default(false),
  strategyRoutingRules: text("strategyRoutingRules"),
  /** 'classic' | 'strategy' (legacy 'opc_agent' reads as classic). */
  routingMode: text("routingMode").notNull().default("strategy"),
  targets: text("targets"), // JSON array of targets for funnel routing
  weight: integer("weight").notNull().default(1),
  priority: integer("priority").notNull().default(0),
  status: text("status").default("active"),
  allowClientModel: integer("allowClientModel", { mode: "boolean" }).notNull().default(false),
  schedules: text("schedules"),
  ipWhitelist: text("ipWhitelist"),
  timeoutEjectEnabled: integer("timeoutEjectEnabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const userRouteOverrides = sqliteTable("user_route_overrides", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  routeId: text("routeId").notNull(),
  modelId: text("modelId"),
  /** When true, gateway matches request body.model against L0; exclusive with modelId. */
  useClientModel: integer("useClientModel", { mode: "boolean" }).notNull().default(false),
  strategyRoutingRules: text("strategyRoutingRules"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (t) => ({
  unq_user_route: unique("unq_user_route").on(t.userId, t.routeId)
}));

export const promptPolicies = sqliteTable("prompt_policies", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  name: text("name").notNull(),
  protocol: text("protocol").notNull().default("openai"), // 'openai' | 'anthropic'
  injectPosition: text("injectPosition").notNull().default("append_system"), // 'messages_unshift' | 'append_system' | 'replace_system' | 'system'
  injectMode: text("injectMode").notNull().default("every_request"), // 'every_request' | 'once_per_conversation'
  conversationKeySource: text("conversationKeySource").default("header"), // 'header' | 'body'
  conversationKeyName: text("conversationKeyName").default("X-Conversation-Id"),
  fallbackMode: text("fallbackMode").default("treat_as_new"), // 'treat_as_new' | 'skip_injection' | 'error'
  content: text("content").notNull(),
  version: integer("version").notNull().default(1),
  description: text("description"),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const promptInjectionRecords = sqliteTable("prompt_injection_records", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  apiKeyId: text("apiKeyId").notNull(),
  endpointId: text("endpointId"),
  subdomainId: text("subdomainId"),
  promptPolicyId: text("promptPolicyId").notNull(),
  conversationId: text("conversationId").notNull(),
  contentHash: text("contentHash").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export const requestLogs = sqliteTable("request_logs", {
  id: text("id").primaryKey(),
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
  streaming: integer("streaming", { mode: "boolean" }).default(false),
  usageStatus: text("usageStatus"), // 'queued' | 'processing' | 'success' | 'estimated' | 'missing' | 'failed'
  errorCode: text("errorCode"),
  errorMessage: text("errorMessage"),
  ipAddress: text("ipAddress"),
  cost: real("cost"),
  routingTrace: text("routingTrace"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
}, (t) => ({
  idx_request_logs_createdat: index("idx_request_logs_createdat").on(t.createdAt),
  idx_request_logs_user_created: index("idx_request_logs_user_created").on(t.userId, t.createdAt),
  idx_request_logs_provider_created: index("idx_request_logs_provider_created").on(t.providerId, t.createdAt),
  idx_request_logs_model_created: index("idx_request_logs_model_created").on(t.model, t.createdAt),
  idx_request_logs_endpoint_created: index("idx_request_logs_endpoint_created").on(t.endpointId, t.createdAt),
  idx_request_logs_subdomain_created: index("idx_request_logs_subdomain_created").on(t.subdomainId, t.createdAt),
  idx_request_logs_api_key_created: index("idx_request_logs_api_key_created").on(t.apiKeyId, t.createdAt),
}));

export const systemSettings = sqliteTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  description: text("description"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const userGroups = sqliteTable("user_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  isDefault: integer("isDefault", { mode: "boolean" }).notNull().default(false),
  maxInputTokens: integer("maxInputTokens").notNull().default(0),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const userGroupMembers = sqliteTable("user_group_members", {
  id: text("id").primaryKey(),
  groupId: text("groupId").notNull(),
  userId: text("userId").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
}, (t) => ({
  unq_group_user: unique("unq_group_user").on(t.groupId, t.userId)
}));

export const routeAuthorizations = sqliteTable("route_authorizations", {
  id: text("id").primaryKey(),
  routeId: text("routeId").notNull(),
  userId: text("userId"),
  groupId: text("groupId"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
}, (t) => ({
  unq_route_user: unique("unq_route_user").on(t.routeId, t.userId),
  unq_route_group: unique("unq_route_group").on(t.routeId, t.groupId)
}));

export const openapiKeys = sqliteTable("openapi_keys", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  name: text("name").notNull(),
  keyHash: text("keyHash").notNull(),
  keyPrefix: text("keyPrefix").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  lastUsedAt: integer("lastUsedAt", { mode: "timestamp" }),
});

export const chatLogs = sqliteTable("chat_logs", {
  id: text("id").primaryKey(),
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
  isAborted: integer("is_aborted", { mode: "boolean" }).default(false),
  status: text("status").default("success"),
  error: text("error"),
  sessionTitle: text("sessionTitle"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
}, (t) => ({
  idx_chat_logs_userid: index("idx_chat_logs_userid").on(t.userId),
  idx_chat_logs_serversessionid: index("idx_chat_logs_serversessionid").on(t.serverSessionId),
  idx_chat_logs_createdat: index("idx_chat_logs_createdat").on(t.createdAt),
  idx_chat_logs_user_created: index("idx_chat_logs_user_created").on(t.userId, t.createdAt),
  idx_chat_logs_responsehash: index("idx_chat_logs_responsehash").on(t.responseHash),
  idx_chat_logs_rootHash: index("idx_chat_logs_rootHash").on(t.conversationRootHash),
}));

export const actionLogs = sqliteTable("action_logs", {
  id: text("id").primaryKey(),
  timestamp: text("timestamp").notNull(),
  level: text("level").notNull(),
  code: text("code").notNull(),
  serverLine: text("serverLine").notNull(),
  ip: text("ip"),
  params: text("params"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export const responseCache = sqliteTable("response_cache", {
  id: text("id").primaryKey(),
  inputHash: text("inputHash").notNull(),
  inputText: text("inputText").notNull(),
  responseText: text("responseText").notNull(),
  model: text("model"),
  sourceLogId: text("sourceLogId"),
  hitCount: integer("hitCount").notNull().default(0),
  lastHitAt: integer("lastHitAt", { mode: "timestamp" }),
  createdBy: text("createdBy"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (t) => ({
  unq_response_cache_inputhash: unique("unq_response_cache_inputhash").on(t.inputHash),
  idx_response_cache_inputhash: index("idx_response_cache_inputhash").on(t.inputHash),
}));

export const distillationJobs = sqliteTable("distillation_jobs", {
  id: text("id").primaryKey(),
  mode: text("mode").notNull(), // incremental | full_relearn | scheduled_incremental
  status: text("status").notNull().default("pending"),
  analysisRouteId: text("analysisRouteId"),
  userIdsFilter: text("userIdsFilter"), // JSON array
  timeRangeStart: integer("timeRangeStart", { mode: "timestamp" }),
  timeRangeEnd: integer("timeRangeEnd", { mode: "timestamp" }),
  maxRecords: integer("maxRecords"),
  totalItems: integer("totalItems").notNull().default(0),
  processedItems: integer("processedItems").notNull().default(0),
  failedItems: integer("failedItems").notNull().default(0),
  errorMessage: text("errorMessage"),
  generationId: text("generationId").notNull(),
  startedAt: integer("startedAt", { mode: "timestamp" }),
  completedAt: integer("completedAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
}, (t) => ({
  idx_distillation_jobs_status: index("idx_distillation_jobs_status").on(t.status),
  idx_distillation_jobs_created: index("idx_distillation_jobs_created").on(t.createdAt),
}));

export const distillationJobItems = sqliteTable("distillation_job_items", {
  id: text("id").primaryKey(),
  jobId: text("jobId").notNull(),
  chatLogId: text("chatLogId").notNull(),
  userId: text("userId").notNull(),
  status: text("status").notNull().default("pending"),
  errorMessage: text("errorMessage"),
  processedAt: integer("processedAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
}, (t) => ({
  unq_distillation_job_chatlog: unique("unq_distillation_job_chatlog").on(t.jobId, t.chatLogId),
  idx_distillation_job_items_job: index("idx_distillation_job_items_job").on(t.jobId, t.status),
}));

export const distillationLearnedRecords = sqliteTable("distillation_learned_records", {
  chatLogId: text("chatLogId").primaryKey(),
  jobId: text("jobId").notNull(),
  generationId: text("generationId").notNull(),
  learnedAt: integer("learnedAt", { mode: "timestamp" }).notNull(),
});

export const distillationRoutingProposals = sqliteTable("distillation_routing_proposals", {
  id: text("id").primaryKey(),
  jobId: text("jobId").notNull(),
  chatLogId: text("chatLogId"),
  sourceUserId: text("sourceUserId"),
  status: text("status").notNull().default("draft"),
  payload: text("payload").notNull(), // JSON DistillationRecordOutput.routing
  validationResult: text("validationResult"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
}, (t) => ({
  idx_distillation_proposals_status: index("idx_distillation_proposals_status").on(t.status),
}));

export const distillationSignalVersions = sqliteTable("distillation_signal_versions", {
  id: text("id").primaryKey(),
  versionLabel: text("versionLabel").notNull(),
  weightOverrides: text("weightOverrides").notNull(), // JSON
  boundaryRules: text("boundaryRules").notNull(), // JSON array
  proposalIds: text("proposalIds").notNull(), // JSON array
  isActive: integer("isActive", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export const distillationSkillPackages = sqliteTable("distillation_skill_packages", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  username: text("username").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull().default("draft"), // draft | published
  files: text("files").notNull(), // JSON map path -> content
  sourceRecordCount: integer("sourceRecordCount").notNull().default(0),
  jobId: text("jobId"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
}, (t) => ({
  idx_distillation_skill_user: index("idx_distillation_skill_user").on(t.userId, t.version),
}));
