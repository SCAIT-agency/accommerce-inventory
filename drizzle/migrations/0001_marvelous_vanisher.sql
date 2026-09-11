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
