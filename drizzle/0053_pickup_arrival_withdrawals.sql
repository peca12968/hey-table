CREATE TABLE `pickup_arrival_withdrawals` (
	`order_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`operation_id` text NOT NULL,
	`previous_arrived_at` integer NOT NULL,
	`withdrawn_at` integer NOT NULL,
	PRIMARY KEY(`order_id`, `revision`),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pickup_arrival_revision_positive" CHECK("pickup_arrival_withdrawals"."revision">0),
	CONSTRAINT "pickup_arrival_withdrawal_time" CHECK("pickup_arrival_withdrawals"."withdrawn_at">="pickup_arrival_withdrawals"."previous_arrived_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pickup_arrival_withdrawal_operation` ON `pickup_arrival_withdrawals` (`order_id`,`operation_id`);--> statement-breakpoint
ALTER TABLE `orders` ADD `pickup_arrival_revision` integer DEFAULT 0 NOT NULL;