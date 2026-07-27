ALTER TABLE `chat_logs` ADD COLUMN `responseHash` text;
CREATE UNIQUE INDEX IF NOT EXISTS `chat_logs_requestId_unique` ON `chat_logs` (`requestId`);
CREATE INDEX IF NOT EXISTS `idx_chat_logs_responsehash` ON `chat_logs` (`responseHash`);
