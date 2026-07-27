DROP TABLE IF EXISTS `agentic_routing_cache`;
--> statement-breakpoint
CREATE TABLE `__new_provider_models` (
	`id` text PRIMARY KEY NOT NULL,
	`providerId` text NOT NULL,
	`modelId` text NOT NULL,
	`displayName` text NOT NULL,
	`rawJson` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`maxOutputTokens` integer,
	`inputTokenPricePerM` real,
	`outputTokenPricePerM` real,
	`tokenizerRepo` text,
	`active` integer DEFAULT 1 NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_provider_models` (
	`id`,
	`providerId`,
	`modelId`,
	`displayName`,
	`rawJson`,
	`enabled`,
	`maxOutputTokens`,
	`inputTokenPricePerM`,
	`outputTokenPricePerM`,
	`tokenizerRepo`,
	`active`,
	`createdAt`
)
SELECT
	`id`,
	`providerId`,
	`modelId`,
	`displayName`,
	`rawJson`,
	`enabled`,
	`maxOutputTokens`,
	`inputTokenPricePerM`,
	`outputTokenPricePerM`,
	`tokenizerRepo`,
	`active`,
	`createdAt`
FROM `provider_models`;
--> statement-breakpoint
DROP TABLE `provider_models`;
--> statement-breakpoint
ALTER TABLE `__new_provider_models` RENAME TO `provider_models`;
--> statement-breakpoint
CREATE UNIQUE INDEX `unq_provider_model` ON `provider_models` (`providerId`,`modelId`);
--> statement-breakpoint
CREATE TABLE `__new_endpoint_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '',
	`endpointId` text NOT NULL,
	`subdomainId` text,
	`providerId` text NOT NULL,
	`providerProtocol` text DEFAULT 'openai' NOT NULL,
	`modelId` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`promptPolicyId` text,
	`fallbackEnabled` integer DEFAULT 0 NOT NULL,
	`fallbackProviderId` text,
	`fallbackProviderProtocol` text,
	`fallbackModelId` text,
	`fallbackPromptPolicyId` text,
	`fallbackMatchTarget` integer DEFAULT 0 NOT NULL,
	`strategyRoutingEnabled` integer DEFAULT 0 NOT NULL,
	`strategyRoutingRules` text,
	`weight` integer DEFAULT 1 NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active',
	`allowClientModel` integer DEFAULT 0 NOT NULL,
	`schedules` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_endpoint_routes` (
	`id`,
	`name`,
	`endpointId`,
	`subdomainId`,
	`providerId`,
	`providerProtocol`,
	`modelId`,
	`enabled`,
	`promptPolicyId`,
	`fallbackEnabled`,
	`fallbackProviderId`,
	`fallbackProviderProtocol`,
	`fallbackModelId`,
	`fallbackPromptPolicyId`,
	`fallbackMatchTarget`,
	`strategyRoutingEnabled`,
	`strategyRoutingRules`,
	`weight`,
	`priority`,
	`status`,
	`allowClientModel`,
	`schedules`,
	`createdAt`,
	`updatedAt`
)
SELECT
	`id`,
	`name`,
	`endpointId`,
	`subdomainId`,
	`providerId`,
	`providerProtocol`,
	`modelId`,
	`enabled`,
	`promptPolicyId`,
	`fallbackEnabled`,
	`fallbackProviderId`,
	`fallbackProviderProtocol`,
	`fallbackModelId`,
	`fallbackPromptPolicyId`,
	`fallbackMatchTarget`,
	0,
	NULL,
	`weight`,
	`priority`,
	`status`,
	`allowClientModel`,
	`schedules`,
	`createdAt`,
	`updatedAt`
FROM `endpoint_routes`;
--> statement-breakpoint
DROP TABLE `endpoint_routes`;
--> statement-breakpoint
ALTER TABLE `__new_endpoint_routes` RENAME TO `endpoint_routes`;
