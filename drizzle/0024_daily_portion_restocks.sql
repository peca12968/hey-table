CREATE TABLE `daily_portion_restocks` (
	`date` text NOT NULL,
	`dish` text NOT NULL,
	`revision` integer NOT NULL,
	`operation_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`previous_capacity` integer NOT NULL,
	`used` integer NOT NULL,
	`capacity` integer NOT NULL,
	`restocked_at` integer NOT NULL,
	PRIMARY KEY(`date`, `dish`, `revision`),
	CONSTRAINT "daily_restock_revision" CHECK("daily_portion_restocks"."revision" > 1),
	CONSTRAINT "daily_restock_quantity" CHECK("daily_portion_restocks"."quantity" > 0 AND "daily_portion_restocks"."previous_capacity" >= 0 AND "daily_portion_restocks"."used" >= 0
    AND "daily_portion_restocks"."capacity" = MAX("daily_portion_restocks"."previous_capacity","daily_portion_restocks"."used") + "daily_portion_restocks"."quantity" AND "daily_portion_restocks"."capacity" <= 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_portion_restocks_operation_id_unique` ON `daily_portion_restocks` (`operation_id`);