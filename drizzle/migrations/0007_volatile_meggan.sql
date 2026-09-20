ALTER TABLE `change_log` ADD CONSTRAINT `change_log_changedBy_users_id_fk` FOREIGN KEY (`changedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_vendorId_vendors_id_fk` FOREIGN KEY (`vendorId`) REFERENCES `vendors`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales_actuals` ADD CONSTRAINT `sales_actuals_skuId_skus_id_fk` FOREIGN KEY (`skuId`) REFERENCES `skus`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales_actuals` ADD CONSTRAINT `sales_actuals_warehouseId_warehouses_id_fk` FOREIGN KEY (`warehouseId`) REFERENCES `warehouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales_plan` ADD CONSTRAINT `sales_plan_skuId_skus_id_fk` FOREIGN KEY (`skuId`) REFERENCES `skus`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales_plan` ADD CONSTRAINT `sales_plan_warehouseId_warehouses_id_fk` FOREIGN KEY (`warehouseId`) REFERENCES `warehouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shipments` ADD CONSTRAINT `shipments_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `change_log_entity_type_id_idx` ON `change_log` (`entityType`,`entityId`);--> statement-breakpoint
CREATE INDEX `payments_paid_expected_date_idx` ON `payments` (`paid`,`expectedDate`);