DROP INDEX `unq_provider_model`;--> statement-breakpoint
CREATE UNIQUE INDEX `unq_provider_model` ON `provider_models` (`providerId`,`modelId`);--> statement-breakpoint
ALTER TABLE `provider_models` DROP COLUMN `protocol`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_endpoint_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '',
	`endpointId` text NOT NULL,
	`subdomainId` text,
	`providerId` text NOT NULL,
	`providerProtocol` text DEFAULT 'openai' NOT NULL,
	`modelId` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`promptPolicyId` text,
	`fallbackEnabled` integer DEFAULT false NOT NULL,
	`fallbackProviderId` text,
	`fallbackProviderProtocol` text,
	`fallbackModelId` text,
	`fallbackPromptPolicyId` text,
	`fallbackMatchTarget` integer DEFAULT false NOT NULL,
	`agenticRoutingEnabled` integer DEFAULT false NOT NULL,
	`weight` integer DEFAULT 1 NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active',
	`allowClientModel` integer DEFAULT false NOT NULL,
	`schedules` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_endpoint_routes`("id", "name", "endpointId", "subdomainId", "providerId", "providerProtocol", "modelId", "enabled", "promptPolicyId", "fallbackEnabled", "fallbackProviderId", "fallbackProviderProtocol", "fallbackModelId", "fallbackPromptPolicyId", "fallbackMatchTarget", "agenticRoutingEnabled", "weight", "priority", "status", "allowClientModel", "schedules", "createdAt", "updatedAt") SELECT "id", "name", "endpointId", "subdomainId", "providerId", "providerProtocol", "modelId", "enabled", "promptPolicyId", "fallbackEnabled", "fallbackProviderId", "fallbackProviderProtocol", "fallbackModelId", "fallbackPromptPolicyId", "fallbackMatchTarget", "agenticRoutingEnabled", "weight", "priority", "status", "allowClientModel", "schedules", "createdAt", "updatedAt" FROM `endpoint_routes`;--> statement-breakpoint
DROP TABLE `endpoint_routes`;--> statement-breakpoint
ALTER TABLE `__new_endpoint_routes` RENAME TO `endpoint_routes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;