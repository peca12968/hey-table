CREATE TABLE `station_batch_receipts` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`write_id` text NOT NULL,
	`station` text NOT NULL,
	`fingerprint` text NOT NULL,
	`order_ids` text NOT NULL,
	`recorded_at` integer NOT NULL
);
