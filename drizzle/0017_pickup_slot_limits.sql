CREATE TABLE `pickup_slot_limits` (
	`start` integer PRIMARY KEY NOT NULL,
	`capacity` integer,
	`revision` integer NOT NULL,
	CONSTRAINT "pickup_slot_limit_capacity" CHECK("pickup_slot_limits"."capacity" IS NULL OR "pickup_slot_limits"."capacity" >= 0),
	CONSTRAINT "pickup_slot_limit_revision" CHECK("pickup_slot_limits"."revision" > 0)
);
