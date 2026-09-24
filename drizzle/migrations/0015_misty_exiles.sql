ALTER TABLE `purchase_orders` ADD `contractLink` varchar(512);--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `invoiceLink` varchar(512);--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `addOnLink` varchar(512);--> statement-breakpoint
ALTER TABLE `shipments` ADD `quoteLink` varchar(512);--> statement-breakpoint
ALTER TABLE `shipments` ADD `invoiceLink` varchar(512);--> statement-breakpoint
ALTER TABLE `shipments` ADD `customsInvoiceLink` varchar(512);