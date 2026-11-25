CREATE TABLE `return_quote_entries` (
	`order_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`operation_id` text NOT NULL,
	`selection` text NOT NULL,
	`quote` text NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`order_id`, `revision`),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "return_quote_revision" CHECK("return_quote_entries"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `return_quote_entries_operation_id_unique` ON `return_quote_entries` (`operation_id`);