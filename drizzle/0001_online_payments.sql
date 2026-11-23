CREATE TABLE `payment_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`reference` text NOT NULL,
	`merchant` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`trade_id` text,
	`redirect_url` text,
	`created` integer NOT NULL,
	`checked` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_attempts_reference_unique` ON `payment_attempts` (`reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_attempts_trade_id_unique` ON `payment_attempts` (`trade_id`);--> statement-breakpoint
CREATE INDEX `attempt_order` ON `payment_attempts` (`order_id`,`id`);--> statement-breakpoint
ALTER TABLE `orders` ADD `payment_method` text DEFAULT 'cash' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `payment_env` text DEFAULT 'cash' NOT NULL;