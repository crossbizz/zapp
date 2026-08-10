CREATE TABLE `zapp_local_agent_commit_intents` (
	`run_id` text NOT NULL,
	`task_id` text NOT NULL,
	`intent_id` text NOT NULL,
	`paths_json` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `task_id`)
);
