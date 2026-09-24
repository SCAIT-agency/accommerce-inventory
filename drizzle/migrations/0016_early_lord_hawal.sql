ALTER TABLE `po_line_items` ADD `exwUnitPrice` decimal(18,8);--> statement-breakpoint
ALTER TABLE `po_line_items` ADD `labTestUnitPrice` decimal(18,8);--> statement-breakpoint
ALTER TABLE `po_line_items` ADD `inspectionUnitPrice` decimal(18,8);--> statement-breakpoint
ALTER TABLE `po_line_items` ADD `addOnUnitPrice` decimal(18,8);--> statement-breakpoint
ALTER TABLE `shipments` ADD `adminFeesCost` decimal(18,4);--> statement-breakpoint
ALTER TABLE `shipments` ADD `eustAmount` decimal(18,4);--> statement-breakpoint
ALTER TABLE `shipments` ADD `vatAmount` decimal(18,4);