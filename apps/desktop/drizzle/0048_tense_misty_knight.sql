CREATE TABLE `zapp_local_agent_owned_paths` (
	`run_id` text NOT NULL,
	`task_id` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `task_id`, `path`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `zapp_local_agent_operation_receipts_one_pending` ON `zapp_local_agent_operation_receipts` (`run_id`,`task_id`) WHERE "zapp_local_agent_operation_receipts"."status" IS NULL;