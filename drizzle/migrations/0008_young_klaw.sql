ALTER TABLE `inventory_ledger` MODIFY COLUMN `unitCost` decimal(18,6);--> statement-breakpoint
ALTER TABLE `payments` MODIFY COLUMN `expectedAmount` decimal(18,4) NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` MODIFY COLUMN `paidAmount` decimal(18,4);--> statement-breakpoint
ALTER TABLE `payments` MODIFY COLUMN `fxRate` decimal(12,6);--> statement-breakpoint
ALTER TABLE `payments` MODIFY COLUMN `baseCurrencyAmount` decimal(18,4);--> statement-breakpoint
ALTER TABLE `po_line_items` MODIFY COLUMN `unitPrice` decimal(18,4) NOT NULL;--> statement-breakpoint
ALTER TABLE `sales_plan_weekly_inputs` MODIFY COLUMN `plannedRevenue` decimal(18,4) NOT NULL;--> statement-breakpoint
ALTER TABLE `sales_plan_weekly_inputs` MODIFY COLUMN `primaryPercent` decimal(7,4) NOT NULL;--> statement-breakpoint
ALTER TABLE `sales_plan_weekly_recipe_lines` MODIFY COLUMN `unitsPer1000` decimal(12,4) NOT NULL;--> statement-breakpoint
ALTER TABLE `shipment_line_items` MODIFY COLUMN `weightShare` decimal(9,6) NOT NULL;--> statement-breakpoint
ALTER TABLE `shipment_line_items` MODIFY COLUMN `valueShare` decimal(9,6) NOT NULL;--> statement-breakpoint
ALTER TABLE `shipments` MODIFY COLUMN `freightCost` decimal(18,4);--> statement-breakpoint
ALTER TABLE `shipments` MODIFY COLUMN `dutyCost` decimal(18,4);--> statement-breakpoint
ALTER TABLE `transactions` MODIFY COLUMN `amount` decimal(18,4) NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` MODIFY COLUMN `fxRate` decimal(12,6) NOT NULL;