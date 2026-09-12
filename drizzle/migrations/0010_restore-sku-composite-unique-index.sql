ALTER TABLE `skus` DROP INDEX `sku_identifier_unique`;--> statement-breakpoint
ALTER TABLE `skus` ADD UNIQUE KEY `sku_identifier_unique` (`primaryIdentifierType`, `identifierValue`);