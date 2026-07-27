ALTER TABLE `provider_models` ADD `routingGuideline` text;
--> statement-breakpoint
ALTER TABLE `endpoint_routes` ADD `agenticRoutingEnabled` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `endpoint_routes` ADD `agenticRoutingCandidates` text;
--> statement-breakpoint
ALTER TABLE `endpoint_routes` ADD `agenticRoutingMaxHops` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `endpoint_routes` ADD `agenticRoutingBindSession` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `request_logs` ADD `routingTrace` text;
