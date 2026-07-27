CREATE TABLE IF NOT EXISTS `openapi_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`keyHash` text NOT NULL,
	`keyPrefix` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`createdAt` integer NOT NULL,
	`lastUsedAt` integer
);