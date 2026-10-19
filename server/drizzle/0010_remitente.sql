ALTER TABLE `received_emails` ADD `client_id` integer REFERENCES clients(id);--> statement-breakpoint
ALTER TABLE `received_emails` ADD `notice` text;--> statement-breakpoint
ALTER TABLE `received_emails` ADD `notice_reviewed_at` integer;--> statement-breakpoint
ALTER TABLE `received_emails` ADD `notice_reviewed_by` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `received_emails` ADD `processed_at` integer;--> statement-breakpoint
CREATE INDEX `received_emails_client_idx` ON `received_emails` (`client_id`);