CREATE TABLE IF NOT EXISTS `action_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` text NOT NULL,
	`level` text NOT NULL,
	`code` text NOT NULL,
	`serverLine` text NOT NULL,
	`ip` text,
	`params` text,
	`createdAt` integer NOT NULL
);
