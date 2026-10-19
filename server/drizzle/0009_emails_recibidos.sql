CREATE TABLE `mailbox_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_check_started_at` integer,
	CONSTRAINT "mailbox_state_single_row" CHECK("mailbox_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `received_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email_id` integer NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`inline` integer NOT NULL,
	`valid` integer NOT NULL,
	`content` blob NOT NULL,
	FOREIGN KEY (`email_id`) REFERENCES `received_emails`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `received_emails` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`from` text NOT NULL,
	`from_name` text,
	`subject` text NOT NULL,
	`text` text NOT NULL,
	`received_at` integer NOT NULL,
	`ingested_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `received_emails_message_id_unique` ON `received_emails` (`message_id`);--> statement-breakpoint
CREATE INDEX `received_emails_received_at_idx` ON `received_emails` (`received_at`);