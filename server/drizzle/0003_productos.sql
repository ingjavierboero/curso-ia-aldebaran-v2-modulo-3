CREATE TABLE `client_products` (
	`client_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `product_id`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `client_products_product_id_idx` ON `client_products` (`product_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`price_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text DEFAULT 'activo' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "products_price_check" CHECK("products"."price_cents" > 0),
	CONSTRAINT "products_currency_check" CHECK("products"."currency" in ('ARS', 'USD')),
	CONSTRAINT "products_status_check" CHECK("products"."status" in ('activo', 'inactivo'))
);
