CREATE TABLE `shipment_line_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`shipmentId` int NOT NULL,
	`poLineItemId` int NOT NULL,
	`skuId` int NOT NULL,
	`qty` int NOT NULL,
	`weightShare` varchar(16) NOT NULL,
	`valueShare` varchar(16) NOT NULL,
	CONSTRAINT `shipment_line_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `shipments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`shipmentRef` varchar(64) NOT NULL,
	`status` enum('planned','departed','in_transit','customs','delivered') NOT NULL DEFAULT 'planned',
	`customsStatus` enum('not_declared','declared','held','cleared') NOT NULL DEFAULT 'not_declared',
	`customsDeclarationLink` varchar(512),
	`plannedDepartDate` timestamp,
	`actualDepartDate` timestamp,
	`plannedArrivalDate` timestamp,
	`actualArrivalDate` timestamp,
	`freightCost` varchar(32),
	`dutyCost` varchar(32),
	`costCurrency` varchar(8),
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shipments_id` PRIMARY KEY(`id`),
	CONSTRAINT `shipments_shipmentRef_unique` UNIQUE(`shipmentRef`)
);
