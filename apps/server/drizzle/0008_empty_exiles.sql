ALTER TABLE provider_models ADD `maxOutputTokens` integer;--> statement-breakpoint
ALTER TABLE provider_models ADD `inputTokenPricePerM` real;--> statement-breakpoint
ALTER TABLE provider_models ADD `outputTokenPricePerM` real;--> statement-breakpoint
ALTER TABLE request_logs ADD `cost` real;