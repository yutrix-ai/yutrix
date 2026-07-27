CREATE TABLE IF NOT EXISTS `provider_test_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`protocol` text DEFAULT 'openai' NOT NULL,
	`models` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL
);
