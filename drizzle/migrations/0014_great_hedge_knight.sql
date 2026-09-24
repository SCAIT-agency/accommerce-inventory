ALTER TABLE `shipments` ADD `costsLockedAt` timestamp;--> statement-breakpoint
ALTER TABLE `shipments` ADD `costsLockedBy` int;--> statement-breakpoint
ALTER TABLE `shipments` ADD CONSTRAINT `shipments_costsLockedBy_users_id_fk` FOREIGN KEY (`costsLockedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;