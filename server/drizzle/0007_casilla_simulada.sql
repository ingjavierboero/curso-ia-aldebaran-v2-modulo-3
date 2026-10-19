CREATE TABLE `mock_mailbox_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email_id` integer NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`inline` integer DEFAULT false NOT NULL,
	`content` blob NOT NULL,
	FOREIGN KEY (`email_id`) REFERENCES `mock_mailbox_emails`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `mock_mailbox_emails` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`direction` text NOT NULL,
	`message_id` text NOT NULL,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`subject` text NOT NULL,
	`text` text NOT NULL,
	`html` text,
	`date` integer NOT NULL,
	`created_by` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mock_mailbox_message_id_unique` ON `mock_mailbox_emails` (`message_id`);--> statement-breakpoint
CREATE INDEX `mock_mailbox_date_idx` ON `mock_mailbox_emails` (`date`);