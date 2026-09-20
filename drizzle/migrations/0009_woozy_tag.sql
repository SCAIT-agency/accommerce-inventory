ALTER TABLE `skus` ADD `leadTimeDays` int DEFAULT 66 NOT NULL;--> statement-breakpoint
ALTER TABLE `skus` ADD `safetyStockDays` int DEFAULT 14 NOT NULL;