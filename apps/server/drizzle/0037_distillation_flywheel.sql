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
CREATE UNIQUE INDEX `unq_distillation_job_chatlog` ON `distillation_job_items` (`jobId`,`chatLogId`);--> statement-breakpoint
CREATE INDEX `idx_distillation_job_items_job` ON `distillation_job_items` (`jobId`,`status`);--> statement-breakpoint
CREATE TABLE `distillation_learned_records` (
	`chatLogId` text PRIMARY KEY NOT NULL,
	`jobId` text NOT NULL,
	`generationId` text NOT NULL,
	`learnedAt` integer NOT NULL
);
--> statement-breakpoint
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
CREATE INDEX `idx_distillation_skill_user` ON `distillation_skill_packages` (`userId`,`version`);
