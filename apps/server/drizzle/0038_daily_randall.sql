CREATE TABLE `distillation_job_items` (
	`id` text PRIMARY KEY NOT NULL,
	`jobId` text NOT NULL,
	`chatLogId` text NOT NULL,
	`userId` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`errorMessage` text,
	`processedAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_distillation_job_items_job` ON `distillation_job_items` (`jobId`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `unq_distillation_job_chatlog` ON `distillation_job_items` (`jobId`,`chatLogId`);--> statement-breakpoint
CREATE TABLE `distillation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`analysisRouteId` text,
	`userIdsFilter` text,
	`timeRangeStart` integer,
	`timeRangeEnd` integer,
	`maxRecords` integer,
	`totalItems` integer DEFAULT 0 NOT NULL,
	`processedItems` integer DEFAULT 0 NOT NULL,
	`failedItems` integer DEFAULT 0 NOT NULL,
	`errorMessage` text,
	`generationId` text NOT NULL,
	`startedAt` integer,
	`completedAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_distillation_jobs_status` ON `distillation_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_distillation_jobs_created` ON `distillation_jobs` (`createdAt`);--> statement-breakpoint
CREATE TABLE `distillation_learned_records` (
	`chatLogId` text PRIMARY KEY NOT NULL,
	`jobId` text NOT NULL,
	`generationId` text NOT NULL,
	`learnedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_distillation_learned_records_jobid` ON `distillation_learned_records` (`jobId`);--> statement-breakpoint
CREATE TABLE `distillation_routing_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`jobId` text NOT NULL,
	`chatLogId` text,
	`sourceUserId` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`payload` text NOT NULL,
	`validationResult` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_distillation_proposals_status` ON `distillation_routing_proposals` (`status`);--> statement-breakpoint
CREATE INDEX `idx_distillation_proposals_jobid` ON `distillation_routing_proposals` (`jobId`);--> statement-breakpoint
CREATE TABLE `distillation_signal_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`versionLabel` text NOT NULL,
	`weightOverrides` text NOT NULL,
	`boundaryRules` text NOT NULL,
	`proposalIds` text NOT NULL,
	`isActive` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_distillation_signal_versions_is_active` ON `distillation_signal_versions` (`isActive`);--> statement-breakpoint
CREATE TABLE `distillation_skill_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`username` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`files` text NOT NULL,
	`sourceRecordCount` integer DEFAULT 0 NOT NULL,
	`jobId` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_distillation_skill_user` ON `distillation_skill_packages` (`userId`,`version`);--> statement-breakpoint
DROP INDEX `subdomains_name_unique`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`keyHash` text NOT NULL,
	`keyPrefix` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`rpmLimit` integer,
	`tpmLimit` integer,
	`concurrencyLimit` integer DEFAULT 10 NOT NULL,
	`expiresAt` integer,
	`createdAt` integer NOT NULL,
	`lastUsedAt` integer
);
--> statement-breakpoint
INSERT INTO `__new_api_keys`("id", "userId", "name", "keyHash", "keyPrefix", "status", "rpmLimit", "tpmLimit", "concurrencyLimit", "expiresAt", "createdAt", "lastUsedAt") SELECT "id", "userId", "name", "keyHash", "keyPrefix", "status", "rpmLimit", "tpmLimit", "concurrencyLimit", "expiresAt", "createdAt", "lastUsedAt" FROM `api_keys`;--> statement-breakpoint
DROP TABLE `api_keys`;--> statement-breakpoint
ALTER TABLE `__new_api_keys` RENAME TO `api_keys`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_api_keys_keyhash` ON `api_keys` (`keyHash`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_userid` ON `api_keys` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_user_status` ON `api_keys` (`userId`,`status`);--> statement-breakpoint
CREATE TABLE `__new_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`openaiBaseUrl` text,
	`anthropicBaseUrl` text,
	`concurrencyLimit` integer DEFAULT 10 NOT NULL,
	`timeoutMs` integer DEFAULT 30000 NOT NULL,
	`streamTimeoutMs` integer DEFAULT 300000 NOT NULL,
	`maxOutputTokens` integer DEFAULT 0 NOT NULL,
	`hourlyTokenLimit` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`manualModels` text,
	`lastTestAt` integer,
	`lastTestStatus` text,
	`lastTestMessage` text,
	`upstreamProxyUrl` text,
	`weightProxyUrl` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_providers`("id", "name", "openaiBaseUrl", "anthropicBaseUrl", "concurrencyLimit", "timeoutMs", "streamTimeoutMs", "maxOutputTokens", "hourlyTokenLimit", "enabled", "manualModels", "lastTestAt", "lastTestStatus", "lastTestMessage", "upstreamProxyUrl", "weightProxyUrl", "createdAt", "updatedAt") SELECT "id", "name", "openaiBaseUrl", "anthropicBaseUrl", "concurrencyLimit", "timeoutMs", "streamTimeoutMs", "maxOutputTokens", "hourlyTokenLimit", "enabled", "manualModels", "lastTestAt", "lastTestStatus", "lastTestMessage", "upstreamProxyUrl", "weightProxyUrl", "createdAt", "updatedAt" FROM `providers`;--> statement-breakpoint
DROP TABLE `providers`;--> statement-breakpoint
ALTER TABLE `__new_providers` RENAME TO `providers`;--> statement-breakpoint
ALTER TABLE `endpoint_routes` ADD `routingMode` text DEFAULT 'strategy' NOT NULL;--> statement-breakpoint
ALTER TABLE `endpoint_routes` ADD `targets` text;--> statement-breakpoint
ALTER TABLE `endpoint_routes` ADD `ipWhitelist` text;--> statement-breakpoint
ALTER TABLE `endpoint_routes` ADD `timeoutEjectEnabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_endpoint_routes_endpointid` ON `endpoint_routes` (`endpointId`);--> statement-breakpoint
CREATE INDEX `idx_endpoint_routes_subdomainid` ON `endpoint_routes` (`subdomainId`);--> statement-breakpoint
CREATE INDEX `idx_endpoint_routes_endpoint_status` ON `endpoint_routes` (`endpointId`,`status`);--> statement-breakpoint
ALTER TABLE `provider_models` ADD `contextWindowTokens` integer;--> statement-breakpoint
ALTER TABLE `provider_models` ADD `alias` text;--> statement-breakpoint
ALTER TABLE `provider_models` ADD `useOpencodeProxy` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user_route_overrides` ADD `useClientModel` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_action_logs_createdat` ON `action_logs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_chat_logs_session_created` ON `chat_logs` (`serverSessionId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_chat_logs_user_client_session` ON `chat_logs` (`userId`,`clientSessionId`);--> statement-breakpoint
CREATE INDEX `idx_invite_codes_codehash` ON `invite_codes` (`codeHash`);--> statement-breakpoint
CREATE INDEX `idx_openapi_keys_keyhash` ON `openapi_keys` (`keyHash`);--> statement-breakpoint
CREATE INDEX `idx_openapi_keys_userid` ON `openapi_keys` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_prompt_injection_records_conv_policy` ON `prompt_injection_records` (`conversationId`,`promptPolicyId`);--> statement-breakpoint
CREATE INDEX `idx_prompt_injection_records_user_created` ON `prompt_injection_records` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_provider_api_keys_provider_status` ON `provider_api_keys` (`providerId`,`status`);--> statement-breakpoint
CREATE INDEX `idx_provider_api_keys_providerid` ON `provider_api_keys` (`providerId`);--> statement-breakpoint
CREATE INDEX `idx_request_logs_createdat` ON `request_logs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_request_logs_user_created` ON `request_logs` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_request_logs_provider_created` ON `request_logs` (`providerId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_request_logs_model_created` ON `request_logs` (`model`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_request_logs_endpoint_created` ON `request_logs` (`endpointId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_request_logs_subdomain_created` ON `request_logs` (`subdomainId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_request_logs_api_key_created` ON `request_logs` (`apiKeyId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_response_cache_createdat` ON `response_cache` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_route_authorizations_userid` ON `route_authorizations` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_route_authorizations_groupid` ON `route_authorizations` (`groupId`);--> statement-breakpoint
CREATE UNIQUE INDEX `unq_user_one_group` ON `user_group_members` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_users_status` ON `users` (`status`);