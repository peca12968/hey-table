CREATE TABLE `daily_portion_limits` (
	`date` text NOT NULL,
	`dish` text NOT NULL,
	`capacity` integer,
	`revision` integer NOT NULL,
	PRIMARY KEY(`date`, `dish`),
	CONSTRAINT "daily_portion_capacity" CHECK("daily_portion_limits"."capacity" IS NULL OR "daily_portion_limits"."capacity" >= 0),
	CONSTRAINT "daily_portion_revision" CHECK("daily_portion_limits"."revision" > 0)
);
