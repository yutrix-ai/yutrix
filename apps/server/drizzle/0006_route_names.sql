ALTER TABLE `endpoint_routes` ADD `name` text DEFAULT '';--> statement-breakpoint
UPDATE `endpoint_routes`
SET `name` = COALESCE(
  (SELECT `name` FROM `endpoints` WHERE `endpoints`.`id` = `endpoint_routes`.`endpointId`),
  ''
)
WHERE `name` IS NULL OR `name` = '';
