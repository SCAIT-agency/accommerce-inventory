CREATE TABLE `app_settings` (
	`key` varchar(128) NOT NULL,
	`value` text NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `app_settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `change_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`entityType` varchar(64) NOT NULL,
	`entityId` int NOT NULL,
	`field` varchar(128) NOT NULL,
	`oldValue` text,
	`newValue` text,
	`reasonCategory` enum('production_delay','artwork_delay','customs_hold','logistics_delay','payment_timing','vendor_price_change','freight_rate_change','holiday_capacity','other'),
	`reasonNote` text,
	`changedBy` int NOT NULL,
	`changedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `change_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inventory_ledger` (
	`id` int AUTO_INCREMENT NOT NULL,
	`skuId` int NOT NULL,
	`warehouseId` int NOT NULL,
	`eventType` enum('receipt','sale','adjustment') NOT NULL,
	`qty` int NOT NULL,
	`unitCost` varchar(32),
	`date` timestamp(3) NOT NULL,
	`sourceRef` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `inventory_ledger_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`poId` int,
	`shipmentId` int,
	`sequenceNo` int NOT NULL,
	`expectedAmount` varchar(32) NOT NULL,
	`expectedDate` timestamp NOT NULL,
	`currency` varchar(8) NOT NULL,
	`paid` boolean NOT NULL DEFAULT false,
	`paidAmount` varchar(32),
	`paidDate` timestamp,
	`fxRate` varchar(16),
	`baseCurrencyAmount` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
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
	`vendorReference` varchar(128),
	`status` enum('draft','confirmed','in_production','shipped','customs','delivered','closed') NOT NULL DEFAULT 'draft',
	`plannedReadyDate` timestamp,
	`notes` text,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `purchase_orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `purchase_orders_poNumber_unique` UNIQUE(`poNumber`)
);
--> statement-breakpoint
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
--> statement-breakpoint
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
	`vendorReference` varchar(128),
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
--> statement-breakpoint
CREATE TABLE `skus` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sku` varchar(128),
	`ssku` varchar(128),
	`asin` varchar(32),
	`ean` varchar(32),
	`fnsku` varchar(32),
	`name` varchar(256),
	`primaryIdentifierType` enum('sku','ssku','asin','ean','fnsku','name') NOT NULL,
	`identifierValue` varchar(256) GENERATED ALWAYS AS (case
          when primaryIdentifierType = 'sku' then sku
          when primaryIdentifierType = 'ssku' then ssku
          when primaryIdentifierType = 'asin' then asin
          when primaryIdentifierType = 'ean' then ean
          when primaryIdentifierType = 'fnsku' then fnsku
          else name
        end) STORED NOT NULL,
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`isBundle` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `skus_id` PRIMARY KEY(`id`),
	CONSTRAINT `sku_identifier_unique` UNIQUE(`primaryIdentifierType`,`identifierValue`)
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`date` timestamp NOT NULL,
	`amount` varchar(32) NOT NULL,
	`currency` varchar(8) NOT NULL,
	`fxRate` varchar(16) NOT NULL,
	`counterparty` varchar(256),
	`description` text,
	`matchedPaymentId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(320) NOT NULL,
	`role` enum('editor','viewer') NOT NULL,
	`managerId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `vendors` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(256) NOT NULL,
	`contactEmail` varchar(320),
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `vendors_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `warehouses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `warehouses_id` PRIMARY KEY(`id`),
	CONSTRAINT `warehouses_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
ALTER TABLE `inventory_ledger` ADD CONSTRAINT `inventory_ledger_skuId_skus_id_fk` FOREIGN KEY (`skuId`) REFERENCES `skus`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory_ledger` ADD CONSTRAINT `inventory_ledger_warehouseId_warehouses_id_fk` FOREIGN KEY (`warehouseId`) REFERENCES `warehouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_poId_purchase_orders_id_fk` FOREIGN KEY (`poId`) REFERENCES `purchase_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_shipmentId_shipments_id_fk` FOREIGN KEY (`shipmentId`) REFERENCES `shipments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `po_line_items` ADD CONSTRAINT `po_line_items_poId_purchase_orders_id_fk` FOREIGN KEY (`poId`) REFERENCES `purchase_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `po_line_items` ADD CONSTRAINT `po_line_items_skuId_skus_id_fk` FOREIGN KEY (`skuId`) REFERENCES `skus`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shipment_line_items` ADD CONSTRAINT `shipment_line_items_shipmentId_shipments_id_fk` FOREIGN KEY (`shipmentId`) REFERENCES `shipments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shipment_line_items` ADD CONSTRAINT `shipment_line_items_poLineItemId_po_line_items_id_fk` FOREIGN KEY (`poLineItemId`) REFERENCES `po_line_items`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shipment_line_items` ADD CONSTRAINT `shipment_line_items_skuId_skus_id_fk` FOREIGN KEY (`skuId`) REFERENCES `skus`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transactions` ADD CONSTRAINT `transactions_matchedPaymentId_payments_id_fk` FOREIGN KEY (`matchedPaymentId`) REFERENCES `payments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `sku_warehouse_date_idx` ON `inventory_ledger` (`skuId`,`warehouseId`,`date`);