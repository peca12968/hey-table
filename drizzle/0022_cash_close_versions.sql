CREATE TABLE `cash_close_versions` (
	`date` text NOT NULL,
	`revision` integer NOT NULL,
	`operation_id` text NOT NULL,
	`saved_at` integer NOT NULL,
	`snapshot` text NOT NULL,
	PRIMARY KEY(`date`, `revision`),
	CONSTRAINT "cash_close_revision" CHECK("cash_close_versions"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_close_versions_operation_id_unique` ON `cash_close_versions` (`operation_id`);