CREATE TABLE `pickup_delay_updates` (
	`order_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`operation_id` text NOT NULL,
	`ready_at` integer,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`order_id`, `revision`),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pickup_delay_revision" CHECK("pickup_delay_updates"."revision">0),
	CONSTRAINT "pickup_delay_future" CHECK("pickup_delay_updates"."ready_at" IS NULL OR "pickup_delay_updates"."ready_at">"pickup_delay_updates"."recorded_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pickup_delay_updates_operation_id_unique` ON `pickup_delay_updates` (`operation_id`);