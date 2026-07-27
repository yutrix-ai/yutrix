CREATE TABLE IF NOT EXISTS `chat_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`requestId` text,
	`serverSessionId` text,
	`clientSessionId` text,
	`turnId` integer DEFAULT 0 NOT NULL,
	`userId` text NOT NULL,
	`clientName` text,
	`model` text,
	`inputText` text,
	`outputText` text,
	`inputTokens` integer DEFAULT 0,
	`outputTokens` integer DEFAULT 0,
	`latencyMs` integer DEFAULT 0,
	`status` text DEFAULT 'success',
	`error` text,
	`createdAt` integer NOT NULL
);
