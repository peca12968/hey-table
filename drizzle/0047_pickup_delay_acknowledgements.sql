CREATE TABLE `pickup_delay_acknowledgements` (
	`order_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`acknowledged_at` integer NOT NULL,
	PRIMARY KEY(`order_id`, `revision`),
	FOREIGN KEY (`order_id`,`revision`) REFERENCES `pickup_delay_updates`(`order_id`,`revision`) ON UPDATE no action ON DELETE no action
);
