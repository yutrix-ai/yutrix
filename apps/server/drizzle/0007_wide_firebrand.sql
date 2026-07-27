CREATE TABLE IF NOT EXISTS `user_route_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`routeId` text NOT NULL,
	`modelId` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE endpoint_routes ADD `allowClientModel` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unq_user_route` ON `user_route_overrides` (`userId`,`routeId`);