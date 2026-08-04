ALTER TABLE "agent_events" ADD COLUMN "project_id" text;
--> statement-breakpoint
UPDATE "agent_events" AS event
   SET "project_id" = run."project_id"
  FROM "agent_runs" AS run
 WHERE event."run_id" = run."id";
--> statement-breakpoint
ALTER TABLE "agent_events" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_events" ADD COLUMN "phase_id" text;
--> statement-breakpoint
ALTER TABLE "agent_events" ADD COLUMN "task_id" text;
--> statement-breakpoint
ALTER TABLE "agent_events" ADD COLUMN "agent_id" text;
--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_project_tenant_fk" FOREIGN KEY ("project_id", "organization_id") REFERENCES "public"."projects"("id", "organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_phase_id_agent_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."agent_phases"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;
