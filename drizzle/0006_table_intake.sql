CREATE TABLE `table_intake` (
	`table_no` text PRIMARY KEY NOT NULL,
	`accepting` integer NOT NULL,
	`revision` integer NOT NULL,
	CONSTRAINT "table_intake_accepting" CHECK("table_intake"."accepting" IN (0,1)),
	CONSTRAINT "table_intake_revision" CHECK("table_intake"."revision" > 0)
);
