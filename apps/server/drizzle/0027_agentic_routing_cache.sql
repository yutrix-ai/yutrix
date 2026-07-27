CREATE TABLE IF NOT EXISTS `agentic_routing_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`cacheKey` text NOT NULL,
	`routeId` text NOT NULL,
	`currentProviderId` text NOT NULL,
	`currentProviderProtocol` text DEFAULT 'openai' NOT NULL,
	`currentModelId` text NOT NULL,
	`candidateSetHash` text NOT NULL,
	`inputHash` text NOT NULL,
	`semanticHash` text NOT NULL,
	`normalizedInput` text NOT NULL,
	`taskType` text DEFAULT 'general' NOT NULL,
	`language` text DEFAULT 'unknown' NOT NULL,
	`hasImageInput` integer DEFAULT 0 NOT NULL,
	`hasRecentImageInput` integer DEFAULT 0 NOT NULL,
	`decision` text DEFAULT 'stay' NOT NULL,
	`targetProviderId` text,
	`targetProviderName` text,
	`targetProviderProtocol` text,
	`targetModelId` text,
	`reason` text,
	`flashProviderName` text,
	`flashModelId` text,
	`flashPrompt` text,
	`flashResponse` text,
	`inputTokens` integer DEFAULT 0 NOT NULL,
	`outputTokens` integer DEFAULT 0 NOT NULL,
	`latencyMs` integer DEFAULT 0 NOT NULL,
	`hitCount` integer DEFAULT 0 NOT NULL,
	`lastHitAt` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unq_agentic_routing_cache_key` ON `agentic_routing_cache` (`cacheKey`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agentic_routing_cache_lookup` ON `agentic_routing_cache` (`routeId`,`currentProviderId`,`currentModelId`,`candidateSetHash`,`taskType`,`hasImageInput`,`status`,`expiresAt`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agentic_routing_cache_inputhash` ON `agentic_routing_cache` (`inputHash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agentic_routing_cache_expires` ON `agentic_routing_cache` (`expiresAt`);
