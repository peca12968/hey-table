CREATE INDEX `table_handoff_receipts_day` ON `table_handoff_receipts` (`completed_at`,`operation_id`);--> statement-breakpoint
CREATE INDEX `table_handoff_receipts_table_day` ON `table_handoff_receipts` (`table_no`,`completed_at`,`operation_id`);
