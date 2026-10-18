CREATE TABLE `exchange_rates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rate_cents` integer NOT NULL,
	`source` text NOT NULL,
	`read_at` integer NOT NULL,
	CONSTRAINT "exchange_rates_rate_check" CHECK("exchange_rates"."rate_cents" > 0)
);
--> statement-breakpoint
CREATE INDEX `exchange_rates_read_at_idx` ON `exchange_rates` (`read_at`);