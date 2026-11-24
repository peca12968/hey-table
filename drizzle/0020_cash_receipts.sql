CREATE TABLE `cash_receipts` (
	`order_id` integer PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`amount` integer NOT NULL,
	`tendered` integer NOT NULL,
	`collected_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cash_receipt_amount" CHECK("cash_receipts"."amount" >= 0 AND "cash_receipts"."tendered" >= "cash_receipts"."amount")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_receipts_operation_id_unique` ON `cash_receipts` (`operation_id`);