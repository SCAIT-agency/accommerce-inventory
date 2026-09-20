ALTER TABLE `users` ADD `passwordHash` varchar(255);--> statement-breakpoint
ALTER TABLE `users` ADD `tokenVersion` int DEFAULT 0 NOT NULL;