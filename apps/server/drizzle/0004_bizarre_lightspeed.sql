ALTER TABLE endpoint_routes ADD `fallbackEnabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE endpoint_routes ADD `fallbackProviderId` text;--> statement-breakpoint
ALTER TABLE endpoint_routes ADD `fallbackProviderProtocol` text;--> statement-breakpoint
ALTER TABLE endpoint_routes ADD `fallbackModelId` text;--> statement-breakpoint
ALTER TABLE endpoint_routes ADD `fallbackPromptPolicyId` text;--> statement-breakpoint
ALTER TABLE providers ADD `maxOutputTokens` integer DEFAULT 0 NOT NULL;