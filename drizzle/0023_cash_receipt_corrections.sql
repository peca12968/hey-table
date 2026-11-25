CREATE TABLE `cash_receipt_corrections` (
	`order_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`operation_id` text NOT NULL,
	`previous_tendered` integer NOT NULL,
	`tendered` integer NOT NULL,
	`reason` text NOT NULL,
	`corrected_at` integer NOT NULL,
	PRIMARY KEY(`order_id`, `revision`),
	FOREIGN KEY (`order_id`) REFERENCES `cash_receipts`(`order_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cash_correction_revision" CHECK("cash_receipt_corrections"."revision" > 0),
	CONSTRAINT "cash_correction_amount" CHECK("cash_receipt_corrections"."previous_tendered" >= 0 AND "cash_receipt_corrections"."tendered" >= 0 AND "cash_receipt_corrections"."previous_tendered" <> "cash_receipt_corrections"."tendered")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_receipt_corrections_operation_id_unique` ON `cash_receipt_corrections` (`operation_id`);