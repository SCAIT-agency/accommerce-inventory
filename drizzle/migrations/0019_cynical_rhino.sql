ALTER TABLE `vendors` ADD `type` enum('manufacturer','trading_company','agent','other') DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `products` json DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `active` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `createdBy` int;--> statement-breakpoint
ALTER TABLE `vendors` ADD `updatedBy` int;--> statement-breakpoint
ALTER TABLE `vendors` ADD CONSTRAINT `vendors_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vendors` ADD CONSTRAINT `vendors_updatedBy_users_id_fk` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;