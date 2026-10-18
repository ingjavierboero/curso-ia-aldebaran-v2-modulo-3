CREATE TABLE `billing_periods` (
	`period` text PRIMARY KEY NOT NULL,
	`cancelled_at` integer,
	`cancelled_by` integer,
	`started_at` integer,
	`started_by` integer,
	`finished_at` integer,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`started_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `invoice_attempts` (
	`client_id` integer NOT NULL,
	`period` text NOT NULL,
	`point_of_sale` integer NOT NULL,
	`pending_number` integer NOT NULL,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `period`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `invoice_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`product_id` integer,
	`description` text NOT NULL,
	`currency` text NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`period` text NOT NULL,
	`status` text DEFAULT 'pendiente_pago' NOT NULL,
	`review_reason` text,
	`voucher_type` integer NOT NULL,
	`point_of_sale` integer NOT NULL,
	`number` integer NOT NULL,
	`cae` text NOT NULL,
	`cae_due_date` text NOT NULL,
	`issue_date` text NOT NULL,
	`service_from` text NOT NULL,
	`service_to` text NOT NULL,
	`payment_due_date` text NOT NULL,
	`total_cents` integer NOT NULL,
	`client_business_name` text NOT NULL,
	`client_cuit` text NOT NULL,
	`client_address` text,
	`client_iva_condition` integer NOT NULL,
	`exchange_rate_id` integer,
	`exchange_rate_cents` integer,
	`exchange_rate_source` text,
	`exchange_rate_read_at` integer,
	`exchange_rate_fallback` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`exchange_rate_id`) REFERENCES `exchange_rates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoices_status_check" CHECK("invoices"."status" in ('pendiente_pago', 'pago_recibido', 'revision_manual', 'pagada')),
	CONSTRAINT "invoices_total_check" CHECK("invoices"."total_cents" > 0)
);
--> statement-breakpoint
CREATE INDEX `invoices_client_period_idx` ON `invoices` (`client_id`,`period`);--> statement-breakpoint
CREATE INDEX `invoices_status_idx` ON `invoices` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_voucher_unique` ON `invoices` (`voucher_type`,`point_of_sale`,`number`);--> statement-breakpoint
CREATE TABLE `process_errors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operation` text NOT NULL,
	`status` text DEFAULT 'pendiente' NOT NULL,
	`client_id` integer,
	`period` text,
	`invoice_id` integer,
	`attempts` integer NOT NULL,
	`last_error` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_by` integer,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "process_errors_operation_check" CHECK("process_errors"."operation" in ('generacion_factura', 'envio_factura', 'envio_recordatorio', 'revision_casilla'))
);
--> statement-breakpoint
CREATE INDEX `process_errors_status_idx` ON `process_errors` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`mailbox_interval_minutes` integer DEFAULT 15 NOT NULL,
	`billing_time` text DEFAULT '11:00' NOT NULL,
	`reminder_time` text DEFAULT '11:00' NOT NULL,
	`retry_count` integer DEFAULT 3 NOT NULL,
	`retry_wait_minutes` integer DEFAULT 5 NOT NULL,
	`point_of_sale` integer DEFAULT 1 NOT NULL,
	`issuer_business_name` text,
	`issuer_address` text,
	`issuer_iva_condition` text,
	`issuer_gross_income_number` text,
	`issuer_activity_start_date` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "settings_single_row" CHECK("settings"."id" = 1)
);
