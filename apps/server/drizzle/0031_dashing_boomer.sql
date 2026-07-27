ALTER TABLE `endpoint_routes` ADD `retryCount` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `providers` ADD `streamTimeoutMs` integer DEFAULT 180000 NOT NULL;