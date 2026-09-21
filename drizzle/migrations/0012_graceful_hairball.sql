ALTER TABLE `shipment_line_items` MODIFY COLUMN `weightShare` decimal(9,8) NOT NULL;--> statement-breakpoint
ALTER TABLE `shipment_line_items` MODIFY COLUMN `valueShare` decimal(9,8) NOT NULL;