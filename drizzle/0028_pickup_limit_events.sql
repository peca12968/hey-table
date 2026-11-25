CREATE TABLE `pickup_limit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operation_id` text NOT NULL,
	`date` text NOT NULL,
	`changed_at` integer NOT NULL,
	`kind` text NOT NULL,
	`changes` text NOT NULL,
	CONSTRAINT "pickup_limit_event_kind" CHECK("pickup_limit_events"."kind" IN ('slot','batch','day'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pickup_limit_events_operation_id_unique` ON `pickup_limit_events` (`operation_id`);--> statement-breakpoint
CREATE INDEX `pickup_limit_events_date` ON `pickup_limit_events` (`date`,`id`);