CREATE TABLE `zapp_local_agent_sessions` (
	`run_id` text NOT NULL,
	`task_id` text NOT NULL,
	`version` integer NOT NULL,
	`transcript_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `task_id`)
);
