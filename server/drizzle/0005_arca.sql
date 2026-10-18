CREATE TABLE `arca_access_tickets` (
	`service` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`sign` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mock_arca_vouchers` (
	`point_of_sale` integer NOT NULL,
	`voucher_type` integer NOT NULL,
	`number` integer NOT NULL,
	`cae` text NOT NULL,
	`cae_due_date` text NOT NULL,
	`issue_date` text NOT NULL,
	`receiver_cuit` text NOT NULL,
	`total_cents` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`point_of_sale`, `voucher_type`, `number`)
);
