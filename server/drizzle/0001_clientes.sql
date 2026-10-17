CREATE TABLE `client_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`type` text NOT NULL,
	`data` text,
	`user_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `client_events_client_id_idx` ON `client_events` (`client_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`business_name` text NOT NULL,
	`cuit` text NOT NULL,
	`billing_email` text NOT NULL,
	`iva_condition` integer,
	`status` text DEFAULT 'activo' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "clients_iva_condition_check" CHECK("clients"."iva_condition" in (1, 4, 5, 6, 7, 8, 9, 10, 13, 15, 16)),
	CONSTRAINT "clients_status_check" CHECK("clients"."status" in ('activo', 'inactivo'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_cuit_unique` ON `clients` (`cuit`);--> statement-breakpoint
CREATE UNIQUE INDEX `clients_billing_email_unique` ON `clients` (lower("billing_email"));