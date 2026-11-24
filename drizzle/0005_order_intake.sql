CREATE TABLE `order_intake` (
	`mode` text PRIMARY KEY NOT NULL,
	`accepting` integer NOT NULL,
	`revision` integer NOT NULL,
	CONSTRAINT "order_intake_mode" CHECK("order_intake"."mode" IN ('pickup','table')),
	CONSTRAINT "order_intake_accepting" CHECK("order_intake"."accepting" IN (0,1)),
	CONSTRAINT "order_intake_revision" CHECK("order_intake"."revision" > 0)
);
