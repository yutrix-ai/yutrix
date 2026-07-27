ALTER TABLE `chat_logs` ADD COLUMN `conversationRootHash` text;
CREATE INDEX IF NOT EXISTS `idx_chat_logs_rootHash` ON `chat_logs` (`conversationRootHash`);
