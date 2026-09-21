ALTER TABLE `inventory_ledger` MODIFY COLUMN `unitCost` decimal(18,8);--> statement-breakpoint
ALTER TABLE `po_line_items` MODIFY COLUMN `unitPrice` decimal(18,8) NOT NULL;