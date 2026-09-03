CREATE TABLE "action_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" text NOT NULL,
	"level" text NOT NULL,
	"code" text NOT NULL,
	"serverLine" text NOT NULL,
	"ip" text,
	"params" text,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"keyHash" text NOT NULL,
	"keyPrefix" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"rpmLimit" integer,
	"tpmLimit" integer,
	"concurrencyLimit" integer DEFAULT 10 NOT NULL,
	"expiresAt" bigint,
	"createdAt" bigint NOT NULL,
	"lastUsedAt" bigint
);
--> statement-breakpoint
CREATE TABLE "chat_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"requestId" text,
	"serverSessionId" text,
	"clientSessionId" text,
	"turnId" integer DEFAULT 0 NOT NULL,
	"userId" text NOT NULL,
	"clientName" text,
	"detectedClient" text,
	"model" text,
	"inputText" text,
	"outputText" text,
	"responseHash" text,
	"conversationRootHash" text,
	"inputTokens" integer DEFAULT 0,
	"outputTokens" integer DEFAULT 0,
	"latencyMs" integer DEFAULT 0,
	"ttft_ms" integer,
	"cached_tokens" integer DEFAULT 0,
	"is_aborted" boolean DEFAULT false,
	"status" text DEFAULT 'success',
	"error" text,
	"sessionTitle" text,
	"createdAt" bigint NOT NULL,
	CONSTRAINT "chat_logs_requestId_unique" UNIQUE("requestId")
);
--> statement-breakpoint
CREATE TABLE "distillation_job_items" (
	"id" text PRIMARY KEY NOT NULL,
	"jobId" text NOT NULL,
	"chatLogId" text NOT NULL,
	"userId" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"errorMessage" text,
	"processedAt" bigint,
	"createdAt" bigint NOT NULL,
	CONSTRAINT "unq_distillation_job_chatlog" UNIQUE("jobId","chatLogId")
);
--> statement-breakpoint
CREATE TABLE "distillation_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"analysisRouteId" text,
	"userIdsFilter" text,
	"timeRangeStart" bigint,
	"timeRangeEnd" bigint,
	"maxRecords" integer,
	"totalItems" integer DEFAULT 0 NOT NULL,
	"processedItems" integer DEFAULT 0 NOT NULL,
	"failedItems" integer DEFAULT 0 NOT NULL,
	"errorMessage" text,
	"generationId" text NOT NULL,
	"startedAt" bigint,
	"completedAt" bigint,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distillation_learned_records" (
	"chatLogId" text PRIMARY KEY NOT NULL,
	"jobId" text NOT NULL,
	"generationId" text NOT NULL,
	"learnedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distillation_routing_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"jobId" text NOT NULL,
	"chatLogId" text,
	"sourceUserId" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"payload" text NOT NULL,
	"validationResult" text,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distillation_signal_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"versionLabel" text NOT NULL,
	"weightOverrides" text NOT NULL,
	"boundaryRules" text NOT NULL,
	"proposalIds" text NOT NULL,
	"isActive" boolean DEFAULT false NOT NULL,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distillation_skill_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"username" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"files" text NOT NULL,
	"sourceRecordCount" integer DEFAULT 0 NOT NULL,
	"jobId" text,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "endpoint_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT '',
	"endpointId" text NOT NULL,
	"subdomainId" text,
	"providerId" text NOT NULL,
	"providerProtocol" text DEFAULT 'openai' NOT NULL,
	"modelId" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"promptPolicyId" text,
	"fallbackEnabled" boolean DEFAULT false NOT NULL,
	"retryCount" integer DEFAULT 3 NOT NULL,
	"fallbackProviderId" text,
	"fallbackProviderProtocol" text,
	"fallbackModelId" text,
	"fallbackPromptPolicyId" text,
	"fallbackMatchTarget" boolean DEFAULT false NOT NULL,
	"fallbackStrategyRoutingEnabled" boolean DEFAULT false NOT NULL,
	"fallbackStrategyRoutingRules" text,
	"strategyRoutingEnabled" boolean DEFAULT false NOT NULL,
	"strategyRoutingRules" text,
	"routingMode" text DEFAULT 'strategy' NOT NULL,
	"targets" text,
	"weight" integer DEFAULT 1 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active',
	"allowClientModel" boolean DEFAULT false NOT NULL,
	"schedules" text,
	"ipWhitelist" text,
	"timeoutEjectEnabled" boolean DEFAULT false NOT NULL,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"name" text DEFAULT '',
	"path" text NOT NULL,
	"virtualModelAlias" text,
	"loadBalanceMode" text DEFAULT 'failover',
	"incomingProtocol" text DEFAULT 'openai' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"timeoutMs" integer DEFAULT 0 NOT NULL,
	"queueTimeoutMs" integer DEFAULT 0 NOT NULL,
	"maxBodyMb" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active',
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL,
	CONSTRAINT "endpoint_unique_idx" UNIQUE("name","path","incomingProtocol")
);
--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"codeHash" text NOT NULL,
	"codePrefix" text NOT NULL,
	"maxUses" integer DEFAULT 1 NOT NULL,
	"usedCount" integer DEFAULT 0 NOT NULL,
	"expiresAt" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"createdBy" text NOT NULL,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openapi_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"keyHash" text NOT NULL,
	"keyPrefix" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"createdAt" bigint NOT NULL,
	"lastUsedAt" bigint
);
--> statement-breakpoint
CREATE TABLE "prompt_injection_records" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"apiKeyId" text NOT NULL,
	"endpointId" text,
	"subdomainId" text,
	"promptPolicyId" text NOT NULL,
	"conversationId" text NOT NULL,
	"contentHash" text NOT NULL,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"protocol" text DEFAULT 'openai' NOT NULL,
	"injectPosition" text DEFAULT 'append_system' NOT NULL,
	"injectMode" text DEFAULT 'every_request' NOT NULL,
	"conversationKeySource" text DEFAULT 'header',
	"conversationKeyName" text DEFAULT 'X-Conversation-Id',
	"fallbackMode" text DEFAULT 'treat_as_new',
	"content" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"providerId" text NOT NULL,
	"keyEncrypted" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL,
	"lastUsedAt" bigint
);
--> statement-breakpoint
CREATE TABLE "provider_models" (
	"id" text PRIMARY KEY NOT NULL,
	"providerId" text NOT NULL,
	"modelId" text NOT NULL,
	"displayName" text NOT NULL,
	"rawJson" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"contextWindowTokens" integer,
	"maxOutputTokens" integer,
	"inputTokenPricePerM" double precision,
	"outputTokenPricePerM" double precision,
	"tokenizerRepo" text,
	"alias" text,
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" bigint NOT NULL,
	CONSTRAINT "unq_provider_model" UNIQUE("providerId","modelId")
);
--> statement-breakpoint
CREATE TABLE "provider_test_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"protocol" text DEFAULT 'openai' NOT NULL,
	"baseUrlHash" text NOT NULL,
	"apiKeyHash" text,
	"models" text NOT NULL,
	"expiresAt" bigint NOT NULL,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"openaiBaseUrl" text,
	"anthropicBaseUrl" text,
	"concurrencyLimit" integer DEFAULT 10 NOT NULL,
	"timeoutMs" integer DEFAULT 30000 NOT NULL,
	"streamTimeoutMs" integer DEFAULT 300000 NOT NULL,
	"maxOutputTokens" integer DEFAULT 0 NOT NULL,
	"hourlyTokenLimit" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"manualModels" text,
	"lastTestAt" bigint,
	"lastTestStatus" text,
	"lastTestMessage" text,
	"upstreamProxyUrl" text,
	"weightProxyUrl" text,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"requestId" text NOT NULL,
	"userId" text NOT NULL,
	"apiKeyId" text,
	"providerId" text,
	"providerApiKeyId" text,
	"endpointId" text,
	"subdomainId" text,
	"protocol" text,
	"model" text,
	"statusCode" integer,
	"inputTokens" integer DEFAULT 0,
	"outputTokens" integer DEFAULT 0,
	"cacheReadTokens" integer DEFAULT 0,
	"cacheWriteTokens" integer DEFAULT 0,
	"totalTokens" integer DEFAULT 0,
	"latencyMs" integer DEFAULT 0,
	"ttftMs" integer DEFAULT 0,
	"streaming" boolean DEFAULT false,
	"usageStatus" text,
	"errorCode" text,
	"errorMessage" text,
	"ipAddress" text,
	"cost" double precision,
	"routingTrace" text,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "response_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"inputHash" text NOT NULL,
	"inputText" text NOT NULL,
	"responseText" text NOT NULL,
	"model" text,
	"sourceLogId" text,
	"hitCount" integer DEFAULT 0 NOT NULL,
	"lastHitAt" bigint,
	"createdBy" text,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL,
	CONSTRAINT "unq_response_cache_inputhash" UNIQUE("inputHash")
);
--> statement-breakpoint
CREATE TABLE "route_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"routeId" text NOT NULL,
	"userId" text,
	"groupId" text,
	"createdAt" bigint NOT NULL,
	CONSTRAINT "unq_route_user" UNIQUE("routeId","userId"),
	CONSTRAINT "unq_route_group" UNIQUE("routeId","groupId")
);
--> statement-breakpoint
CREATE TABLE "subdomains" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"hostname" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"description" text,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL,
	CONSTRAINT "subdomains_hostname_unique" UNIQUE("hostname")
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"description" text,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_group_members" (
	"id" text PRIMARY KEY NOT NULL,
	"groupId" text NOT NULL,
	"userId" text NOT NULL,
	"createdAt" bigint NOT NULL,
	CONSTRAINT "unq_group_user" UNIQUE("groupId","userId")
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"isDefault" boolean DEFAULT false NOT NULL,
	"maxInputTokens" integer DEFAULT 0 NOT NULL,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL,
	CONSTRAINT "user_groups_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "user_route_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"routeId" text NOT NULL,
	"modelId" text,
	"useClientModel" boolean DEFAULT false NOT NULL,
	"strategyRoutingRules" text,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL,
	CONSTRAINT "unq_user_route" UNIQUE("userId","routeId")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"passwordHash" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"maxInputTokensOverride" integer,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL,
	"lastLoginAt" bigint,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE INDEX "idx_chat_logs_userid" ON "chat_logs" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "idx_chat_logs_serversessionid" ON "chat_logs" USING btree ("serverSessionId");--> statement-breakpoint
CREATE INDEX "idx_chat_logs_createdat" ON "chat_logs" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "idx_chat_logs_user_created" ON "chat_logs" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "idx_chat_logs_responsehash" ON "chat_logs" USING btree ("responseHash");--> statement-breakpoint
CREATE INDEX "idx_chat_logs_rootHash" ON "chat_logs" USING btree ("conversationRootHash");--> statement-breakpoint
CREATE INDEX "idx_distillation_job_items_job" ON "distillation_job_items" USING btree ("jobId","status");--> statement-breakpoint
CREATE INDEX "idx_distillation_jobs_status" ON "distillation_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_distillation_jobs_created" ON "distillation_jobs" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "idx_distillation_proposals_status" ON "distillation_routing_proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_distillation_skill_user" ON "distillation_skill_packages" USING btree ("userId","version");--> statement-breakpoint
CREATE INDEX "idx_request_logs_createdat" ON "request_logs" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "idx_request_logs_user_created" ON "request_logs" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "idx_request_logs_provider_created" ON "request_logs" USING btree ("providerId","createdAt");--> statement-breakpoint
CREATE INDEX "idx_request_logs_model_created" ON "request_logs" USING btree ("model","createdAt");--> statement-breakpoint
CREATE INDEX "idx_request_logs_endpoint_created" ON "request_logs" USING btree ("endpointId","createdAt");--> statement-breakpoint
CREATE INDEX "idx_request_logs_subdomain_created" ON "request_logs" USING btree ("subdomainId","createdAt");--> statement-breakpoint
CREATE INDEX "idx_request_logs_api_key_created" ON "request_logs" USING btree ("apiKeyId","createdAt");--> statement-breakpoint
CREATE INDEX "idx_response_cache_inputhash" ON "response_cache" USING btree ("inputHash");