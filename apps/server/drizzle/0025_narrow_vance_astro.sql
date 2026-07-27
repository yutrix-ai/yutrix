CREATE TABLE IF NOT EXISTS `provider_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`providerId` text NOT NULL,
	`keyEncrypted` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`lastUsedAt` integer
);

INSERT INTO `provider_api_keys` (`id`, `providerId`, `keyEncrypted`, `status`, `createdAt`, `updatedAt`)
SELECT 
	lower(hex(randomblob(16))),
	`id`,
	`openaiApiKeyEncrypted`,
	'active',
	CAST(strftime('%s', 'now') * 1000 AS INTEGER),
	CAST(strftime('%s', 'now') * 1000 AS INTEGER)
FROM `providers`
WHERE `openaiApiKeyEncrypted` IS NOT NULL;

INSERT INTO `provider_api_keys` (`id`, `providerId`, `keyEncrypted`, `status`, `createdAt`, `updatedAt`)
SELECT 
	lower(hex(randomblob(16))),
	`id`,
	`anthropicApiKeyEncrypted`,
	'active',
	CAST(strftime('%s', 'now') * 1000 AS INTEGER),
	CAST(strftime('%s', 'now') * 1000 AS INTEGER)
FROM `providers`
WHERE `anthropicApiKeyEncrypted` IS NOT NULL
AND (`openaiApiKeyEncrypted` IS NULL OR `anthropicApiKeyEncrypted` != `openaiApiKeyEncrypted`);
