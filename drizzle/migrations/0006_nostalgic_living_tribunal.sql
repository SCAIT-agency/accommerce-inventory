CREATE TABLE `sales_actuals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`skuId` int NOT NULL,
	`warehouseId` int NOT NULL,
	`date` timestamp NOT NULL,
	`qty` int NOT NULL,
	`source` enum('shopify_daily_pull','manual') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sales_actuals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sales_plan` (
	`id` int AUTO_INCREMENT NOT NULL,
	`skuId` int NOT NULL,
	`warehouseId` int NOT NULL,
	`periodDate` timestamp NOT NULL,
	`plannedQty` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sales_plan_id` PRIMARY KEY(`id`)
);
