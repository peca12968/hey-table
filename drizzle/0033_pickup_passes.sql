CREATE TABLE `pickup_passes` (
	`order_id` integer PRIMARY KEY NOT NULL,
	`token_hash` text,
	`expires_at` integer,
	`revision` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pickup_pass_revision" CHECK("pickup_passes"."revision">0),
	CONSTRAINT "pickup_pass_expiration" CHECK(("pickup_passes"."expires_at" IS NULL)=("pickup_passes"."token_hash" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pickup_passes_token_hash_unique` ON `pickup_passes` (`token_hash`);