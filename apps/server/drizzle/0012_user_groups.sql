CREATE TABLE IF NOT EXISTS `user_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`isDefault` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `user_groups_name_unique` ON `user_groups` (`name`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`groupId` text NOT NULL,
	`userId` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unq_group_user` ON `user_group_members` (`groupId`,`userId`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `route_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`routeId` text NOT NULL,
	`userId` text,
	`groupId` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unq_route_user` ON `route_authorizations` (`routeId`,`userId`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unq_route_group` ON `route_authorizations` (`routeId`,`groupId`);
