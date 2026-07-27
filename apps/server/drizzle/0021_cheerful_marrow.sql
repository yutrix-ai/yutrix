CREATE TABLE IF NOT EXISTS `response_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`inputHash` text NOT NULL,
	`inputText` text NOT NULL,
	`responseText` text NOT NULL,
	`model` text,
	`sourceLogId` text,
	`hitCount` integer DEFAULT 0 NOT NULL,
	`lastHitAt` integer,
	`createdBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_response_cache_inputhash` ON `response_cache` (`inputHash`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unq_response_cache_inputhash` ON `response_cache` (`inputHash`);