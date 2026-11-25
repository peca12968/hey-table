CREATE TABLE `return_ledger_review_events` (
	`date` text NOT NULL,
	`fingerprint` text NOT NULL,
	`order_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`target_revision` integer,
	`reason` text,
	PRIMARY KEY(`date`, `fingerprint`, `order_id`, `revision`),
	FOREIGN KEY (`date`,`fingerprint`) REFERENCES `return_ledger_reviews`(`date`,`fingerprint`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `return_ledger_reviews` ADD `captured_at` integer;