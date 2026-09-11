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
