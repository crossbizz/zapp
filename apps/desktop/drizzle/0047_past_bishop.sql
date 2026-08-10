CREATE TABLE `zapp_local_agent_operation_receipts` (
	`run_id` text NOT NULL,
	`task_id` text NOT NULL,
	`operation_key` text NOT NULL,
	`base_commit_count` integer NOT NULL,
	`status` text,
	`summary` text,
	`commits_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `task_id`, `operation_key`)
);
