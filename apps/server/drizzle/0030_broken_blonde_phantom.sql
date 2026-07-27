ALTER TABLE `user_route_overrides` ADD `strategyRoutingRules` text;--> statement-breakpoint
ALTER TABLE `chat_logs` ADD `ttft_ms` integer;--> statement-breakpoint
ALTER TABLE `chat_logs` ADD `cached_tokens` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `chat_logs` ADD `is_aborted` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `endpoint_routes` ADD `fallbackStrategyRoutingEnabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `endpoint_routes` ADD `fallbackStrategyRoutingRules` text;--> statement-breakpoint
ALTER TABLE `providers` ADD `hourlyTokenLimit` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `providerApiKeyId` text;