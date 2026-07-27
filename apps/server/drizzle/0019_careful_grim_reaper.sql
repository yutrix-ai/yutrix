ALTER TABLE endpoint_routes ADD `fallbackMatchTarget` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chat_logs_userid` ON `chat_logs` (`userId`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chat_logs_serversessionid` ON `chat_logs` (`serverSessionId`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chat_logs_createdat` ON `chat_logs` (`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chat_logs_user_created` ON `chat_logs` (`userId`,`createdAt`);