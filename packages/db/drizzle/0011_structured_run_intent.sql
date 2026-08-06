ALTER TABLE "agent_runs" ADD COLUMN "app_type" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_app_type_check" CHECK (app_type in ('web', 'mobile'));
