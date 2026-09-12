ALTER TABLE `skus` ADD `identifierValue` varchar(256) GENERATED ALWAYS AS (case
        when primaryIdentifierType = 'sku' then sku
        when primaryIdentifierType = 'ssku' then ssku
        when primaryIdentifierType = 'asin' then asin
        when primaryIdentifierType = 'ean' then ean
        when primaryIdentifierType = 'fnsku' then fnsku
        else name
      end) STORED;--> statement-breakpoint
ALTER TABLE `skus` ADD CONSTRAINT `sku_identifier_unique` UNIQUE(`primaryIdentifierType`,`identifierValue`);