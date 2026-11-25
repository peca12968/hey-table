CREATE TABLE `return_quote_voids` (
	`order_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`target_revision` integer NOT NULL,
	`operation_id` text NOT NULL,
	`reason` text NOT NULL,
	`restored_amount` integer NOT NULL,
	`remaining_value` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`order_id`, `revision`),
	FOREIGN KEY (`order_id`,`target_revision`) REFERENCES `return_quote_entries`(`order_id`,`revision`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "return_quote_void_values" CHECK("return_quote_voids"."target_revision" > 0 AND "return_quote_voids"."revision" > "return_quote_voids"."target_revision"
    AND "return_quote_voids"."restored_amount" >= 0 AND "return_quote_voids"."remaining_value" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `return_quote_voids_operation_id_unique` ON `return_quote_voids` (`operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `return_quote_void_target` ON `return_quote_voids` (`order_id`,`target_revision`);