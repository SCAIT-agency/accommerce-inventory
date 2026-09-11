CREATE TABLE `inventory_ledger` (
	`id` int AUTO_INCREMENT NOT NULL,
	`skuId` int NOT NULL,
	`warehouseId` int NOT NULL,
	`eventType` enum('receipt','sale','adjustment') NOT NULL,
	`qty` int NOT NULL,
	`unitCost` varchar(32),
	`date` timestamp NOT NULL,
	`sourceRef` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `inventory_ledger_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `sku_warehouse_date_idx` ON `inventory_ledger` (`skuId`,`warehouseId`,`date`);