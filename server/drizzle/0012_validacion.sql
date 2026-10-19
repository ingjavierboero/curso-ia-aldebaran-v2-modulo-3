CREATE TABLE `invoice_emails` (
	`invoice_id` integer NOT NULL,
	`email_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`invoice_id`, `email_id`),
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`email_id`) REFERENCES `received_emails`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invoice_emails_email_idx` ON `invoice_emails` (`email_id`);--> statement-breakpoint
ALTER TABLE `received_emails` ADD `validation_result` text;--> statement-breakpoint
ALTER TABLE `received_emails` ADD `validation_rule` text;