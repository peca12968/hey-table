CREATE TABLE `demo_refunds` (
	`order_id` integer PRIMARY KEY NOT NULL,
	`attempt_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`previous_status` text NOT NULL,
	`refunded_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `payment_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "demo_refunds_amount" CHECK("demo_refunds"."amount" > 0),
	CONSTRAINT "demo_refunds_status" CHECK("demo_refunds"."previous_status" IN ('pending','preparing','ready','completed','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_refunds_attempt_id_unique` ON `demo_refunds` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `demo_refunds_time` ON `demo_refunds` (`refunded_at`,`order_id`);