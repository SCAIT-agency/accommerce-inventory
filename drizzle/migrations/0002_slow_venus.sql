CREATE TABLE `po_line_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`poId` int NOT NULL,
	`skuId` int NOT NULL,
	`qty` int NOT NULL,
	`unitPrice` varchar(32) NOT NULL,
	`currency` varchar(8) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `po_line_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`poNumber` varchar(64) NOT NULL,
	`vendorId` int NOT NULL,
	`status` enum('draft','confirmed','in_production','shipped','customs','delivered','closed') NOT NULL DEFAULT 'draft',
	`plannedReadyDate` timestamp,
	`notes` text,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `purchase_orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `purchase_orders_poNumber_unique` UNIQUE(`poNumber`)
);
