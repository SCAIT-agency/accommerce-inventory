CREATE TABLE `sales_plan_weekly_inputs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`weekStartDate` date NOT NULL,
	`plannedRevenue` varchar(32) NOT NULL,
	`primaryWarehouseId` int NOT NULL,
	`primaryPercent` varchar(8) NOT NULL,
	`secondaryWarehouseId` int NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sales_plan_weekly_inputs_id` PRIMARY KEY(`id`),
	CONSTRAINT `sales_plan_weekly_inputs_weekStartDate_unique` UNIQUE(`weekStartDate`)
);
--> statement-breakpoint
CREATE TABLE `sales_plan_weekly_recipe_lines` (
	`id` int AUTO_INCREMENT NOT NULL,
	`weeklyInputId` int NOT NULL,
	`skuId` int NOT NULL,
	`unitsPer1000` varchar(16) NOT NULL,
	CONSTRAINT `sales_plan_weekly_recipe_lines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `sales_plan` ADD CONSTRAINT `sales_plan_sku_warehouse_date_unique` UNIQUE(`skuId`,`warehouseId`,`periodDate`);--> statement-breakpoint
ALTER TABLE `sales_plan_weekly_inputs` ADD CONSTRAINT `sales_plan_weekly_inputs_primaryWarehouseId_warehouses_id_fk` FOREIGN KEY (`primaryWarehouseId`) REFERENCES `warehouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales_plan_weekly_inputs` ADD CONSTRAINT `sales_plan_weekly_inputs_secondaryWarehouseId_warehouses_id_fk` FOREIGN KEY (`secondaryWarehouseId`) REFERENCES `warehouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales_plan_weekly_recipe_lines` ADD CONSTRAINT `sales_plan_weekly_recipe_lines_skuId_skus_id_fk` FOREIGN KEY (`skuId`) REFERENCES `skus`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales_plan_weekly_recipe_lines` ADD CONSTRAINT `sales_plan_weekly_recipe_lines_weekly_input_id_fk` FOREIGN KEY (`weeklyInputId`) REFERENCES `sales_plan_weekly_inputs`(`id`) ON DELETE no action ON UPDATE no action;