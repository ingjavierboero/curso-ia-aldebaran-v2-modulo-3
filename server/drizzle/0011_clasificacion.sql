ALTER TABLE `received_attachments` ADD `classification` text;--> statement-breakpoint
ALTER TABLE `received_attachments` ADD `processing_error` text;--> statement-breakpoint
ALTER TABLE `received_attachments` ADD `extracted_cuit` text;--> statement-breakpoint
ALTER TABLE `received_attachments` ADD `extracted_amount` text;--> statement-breakpoint
ALTER TABLE `received_emails` ADD `classification` text;