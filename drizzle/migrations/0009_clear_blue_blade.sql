ALTER TABLE `skus` MODIFY COLUMN `identifierValue` varchar(256) NOT NULL;--> statement-breakpoint
ALTER TABLE `skus` drop column `identifierValue`;--> statement-breakpoint
ALTER TABLE `skus` ADD `identifierValue` varchar(256) GENERATED ALWAYS AS (case
          when primaryIdentifierType = 'sku' then sku
          when primaryIdentifierType = 'ssku' then ssku
          when primaryIdentifierType = 'asin' then asin
          when primaryIdentifierType = 'ean' then ean
          when primaryIdentifierType = 'fnsku' then fnsku
          else name
        end) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `vendorReference` varchar(128);--> statement-breakpoint
ALTER TABLE `shipments` ADD `vendorReference` varchar(128);