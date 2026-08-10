CREATE TABLE `zapp_local_agent_chat_sessions` (
	`chat_id` integer PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `zapp_local_agent_chat_sessions_session_id_unique` ON `zapp_local_agent_chat_sessions` (`session_id`);