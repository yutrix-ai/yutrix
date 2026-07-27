CREATE INDEX IF NOT EXISTS `idx_request_logs_createdat` ON `request_logs` (`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_request_logs_user_created` ON `request_logs` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_request_logs_provider_created` ON `request_logs` (`providerId`,`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_request_logs_model_created` ON `request_logs` (`model`,`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_request_logs_endpoint_created` ON `request_logs` (`endpointId`,`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_request_logs_subdomain_created` ON `request_logs` (`subdomainId`,`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_request_logs_api_key_created` ON `request_logs` (`apiKeyId`,`createdAt`);
