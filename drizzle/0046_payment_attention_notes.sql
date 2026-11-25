CREATE TABLE `payment_attention_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` integer NOT NULL,
	`operation_id` text NOT NULL,
	`state` text NOT NULL,
	`note` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `payment_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_attention_note_state" CHECK("payment_attention_notes"."state" IN ('pending','authorized'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_attention_notes_operation_id_unique` ON `payment_attention_notes` (`operation_id`);--> statement-breakpoint
CREATE INDEX `payment_attention_notes_attempt` ON `payment_attention_notes` (`attempt_id`,`id`);