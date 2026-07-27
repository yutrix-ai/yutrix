ALTER TABLE provider_test_sessions ADD `baseUrlHash` text NOT NULL;--> statement-breakpoint
ALTER TABLE provider_test_sessions ADD `apiKeyHash` text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unq_provider_model` ON `provider_models` (`providerId`,`protocol`,`modelId`);