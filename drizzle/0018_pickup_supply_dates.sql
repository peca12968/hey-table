CREATE INDEX `orders_supply_time` ON `orders` (COALESCE("pickup_slot","created"));
