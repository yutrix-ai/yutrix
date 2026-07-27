CREATE TABLE IF NOT EXISTS `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`keyHash` text NOT NULL,
	`keyPrefix` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`rpmLimit` integer,
	`tpmLimit` integer,
	`concurrencyLimit` integer DEFAULT 2 NOT NULL,
	`expiresAt` integer,
	`createdAt` integer NOT NULL,
	`lastUsedAt` integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `endpoint_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`endpointId` text NOT NULL,
	`subdomainId` text,
	`providerId` text NOT NULL,
	`providerProtocol` text DEFAULT 'openai' NOT NULL,
	`modelId` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`promptPolicyId` text,
	`weight` integer DEFAULT 1 NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active',
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`name` text DEFAULT '',
	`path` text NOT NULL,
	`virtualModelAlias` text,
	`loadBalanceMode` text DEFAULT 'failover',
	`incomingProtocol` text DEFAULT 'openai' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`timeoutMs` integer DEFAULT 60000 NOT NULL,
	`queueTimeoutMs` integer DEFAULT 30000 NOT NULL,
	`maxBodyMb` integer DEFAULT 10 NOT NULL,
	`status` text DEFAULT 'active',
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invite_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`codeHash` text NOT NULL,
	`codePrefix` text NOT NULL,
	`maxUses` integer DEFAULT 1 NOT NULL,
	`usedCount` integer DEFAULT 0 NOT NULL,
	`expiresAt` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`createdBy` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `prompt_injection_records` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`apiKeyId` text NOT NULL,
	`endpointId` text,
	`subdomainId` text,
	`promptPolicyId` text NOT NULL,
	`conversationId` text NOT NULL,
	`contentHash` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `prompt_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`protocol` text DEFAULT 'openai' NOT NULL,
	`injectPosition` text DEFAULT 'append_system' NOT NULL,
	`injectMode` text DEFAULT 'every_request' NOT NULL,
	`conversationKeySource` text DEFAULT 'header',
	`conversationKeyName` text DEFAULT 'X-Conversation-Id',
	`fallbackMode` text DEFAULT 'treat_as_new',
	`content` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`description` text,
	`enabled` integer DEFAULT true,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `provider_models` (
	`id` text PRIMARY KEY NOT NULL,
	`providerId` text NOT NULL,
	`protocol` text NOT NULL,
	`modelId` text NOT NULL,
	`displayName` text NOT NULL,
	`rawJson` text,
	`enabled` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`openaiBaseUrl` text,
	`openaiApiKeyEncrypted` text,
	`anthropicBaseUrl` text,
	`anthropicApiKeyEncrypted` text,
	`concurrencyLimit` integer DEFAULT 10 NOT NULL,
	`timeoutMs` integer DEFAULT 60000 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`manualModels` text,
	`lastTestAt` integer,
	`lastTestStatus` text,
	`lastTestMessage` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `request_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`requestId` text NOT NULL,
	`userId` text NOT NULL,
	`apiKeyId` text,
	`providerId` text,
	`endpointId` text,
	`subdomainId` text,
	`protocol` text,
	`model` text,
	`statusCode` integer,
	`inputTokens` integer DEFAULT 0,
	`outputTokens` integer DEFAULT 0,
	`cacheReadTokens` integer DEFAULT 0,
	`cacheWriteTokens` integer DEFAULT 0,
	`totalTokens` integer DEFAULT 0,
	`latencyMs` integer DEFAULT 0,
	`ttftMs` integer DEFAULT 0,
	`streaming` integer DEFAULT false,
	`usageStatus` text,
	`errorCode` text,
	`errorMessage` text,
	`ipAddress` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `subdomains` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`hostname` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`description` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `system_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`description` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`passwordHash` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`lastLoginAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `subdomains_name_unique` ON `subdomains` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `subdomains_hostname_unique` ON `subdomains` (`hostname`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_username_unique` ON `users` (`username`);