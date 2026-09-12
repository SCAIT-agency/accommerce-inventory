-- Clear existing skus table to allow NOT NULL constraint on identifierValue
DELETE FROM `skus`;--> statement-breakpoint
-- Modify identifierValue column to NOT NULL
ALTER TABLE `skus` MODIFY COLUMN `identifierValue` varchar(256) GENERATED ALWAYS AS (case
          when primaryIdentifierType = 'sku' then sku
          when primaryIdentifierType = 'ssku' then ssku
          when primaryIdentifierType = 'asin' then asin
          when primaryIdentifierType = 'ean' then ean
          when primaryIdentifierType = 'fnsku' then fnsku
          else name
        end) STORED NOT NULL;
