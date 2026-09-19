ALTER TABLE `sales_actuals` MODIFY COLUMN `date` date NOT NULL;--> statement-breakpoint
ALTER TABLE `sales_plan` MODIFY COLUMN `periodDate` date NOT NULL;