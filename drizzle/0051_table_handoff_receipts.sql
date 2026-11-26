CREATE TABLE `table_handoff_receipts` (
    `operation_id` text PRIMARY KEY NOT NULL,
    `write_id` text NOT NULL,
    `table_no` text NOT NULL,
    `reviewed` text NOT NULL,
    `completed_at` integer NOT NULL
);
