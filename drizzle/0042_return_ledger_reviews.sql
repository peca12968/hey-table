CREATE TABLE `return_ledger_reviews` (
	`date` text NOT NULL,
	`fingerprint` text NOT NULL,
	`event_count` integer NOT NULL,
	`net_amount` integer NOT NULL,
	`reviewed_at` integer NOT NULL,
	`note` text NOT NULL,
	PRIMARY KEY(`date`, `fingerprint`),
	CONSTRAINT "return_review_event_count" CHECK("return_ledger_reviews"."event_count" >= 0)
);
