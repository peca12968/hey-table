ALTER TABLE `orders` ADD `pickup_slot` integer;--> statement-breakpoint
CREATE INDEX `orders_pickup_slot` ON `orders` (`pickup_slot`) WHERE "orders"."pickup_slot" IS NOT NULL;