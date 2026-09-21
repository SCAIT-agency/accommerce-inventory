ALTER TABLE `change_log` MODIFY COLUMN `reasonCategory` enum('production_delay','artwork_delay','customs_hold','logistics_delay','payment_timing','vendor_price_change','freight_rate_change','holiday_capacity','data_correction','other');--> statement-breakpoint
ALTER TABLE `inventory_ledger` ADD `lineItemId` int;--> statement-breakpoint
ALTER TABLE `inventory_ledger` ADD `correctsEventId` int;--> statement-breakpoint
ALTER TABLE `inventory_ledger` ADD `changedBy` int;--> statement-breakpoint
ALTER TABLE `inventory_ledger` ADD `reasonCategory` enum('production_delay','artwork_delay','customs_hold','logistics_delay','payment_timing','vendor_price_change','freight_rate_change','holiday_capacity','data_correction','other');--> statement-breakpoint
ALTER TABLE `inventory_ledger` ADD `reasonNote` text;--> statement-breakpoint
ALTER TABLE `inventory_ledger` ADD CONSTRAINT `inventory_ledger_lineItemId_shipment_line_items_id_fk` FOREIGN KEY (`lineItemId`) REFERENCES `shipment_line_items`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory_ledger` ADD CONSTRAINT `inventory_ledger_correctsEventId_inventory_ledger_id_fk` FOREIGN KEY (`correctsEventId`) REFERENCES `inventory_ledger`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory_ledger` ADD CONSTRAINT `inventory_ledger_changedBy_users_id_fk` FOREIGN KEY (`changedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;