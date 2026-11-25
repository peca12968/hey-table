CREATE TABLE `daily_portion_limit_changes` (
	`date` text NOT NULL,
	`dish` text NOT NULL,
	`revision` integer NOT NULL,
	`action_id` text NOT NULL,
	`kind` text NOT NULL,
	`previous_capacity` integer,
	`capacity` integer,
	`source_date` text,
	`changed_at` integer NOT NULL,
	PRIMARY KEY(`date`, `dish`, `revision`),
	CONSTRAINT "daily_portion_changes_kind" CHECK(("daily_portion_limit_changes"."kind"='manual' AND "daily_portion_limit_changes"."source_date" IS NULL) OR
    ("daily_portion_limit_changes"."kind"='copy' AND "daily_portion_limit_changes"."source_date" IS NOT NULL AND "daily_portion_limit_changes"."source_date"<>"daily_portion_limit_changes"."date"))
);
--> statement-breakpoint
CREATE INDEX `daily_portion_changes_action` ON `daily_portion_limit_changes` (`action_id`);