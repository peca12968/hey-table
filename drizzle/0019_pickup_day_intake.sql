CREATE TABLE `pickup_day_intake` (
	`date` text PRIMARY KEY NOT NULL,
	`accepting` integer NOT NULL,
	`revision` integer NOT NULL,
	CONSTRAINT "pickup_day_accepting" CHECK("pickup_day_intake"."accepting" IN (0,1)),
	CONSTRAINT "pickup_day_revision" CHECK("pickup_day_intake"."revision" > 0)
);
