CREATE TABLE "desktop_local_agent_sessions" (
	"session_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "desktop_local_agent_sessions" ADD CONSTRAINT "desktop_local_agent_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_local_agent_sessions" ADD CONSTRAINT "desktop_local_agent_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_local_agent_sessions" ADD CONSTRAINT "desktop_local_agent_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_local_agent_sessions" ADD CONSTRAINT "desktop_local_agent_sessions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_local_agent_sessions" ADD CONSTRAINT "desktop_local_agent_sessions_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_local_agent_sessions" ADD CONSTRAINT "desktop_local_agent_sessions_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_local_agent_sessions_scope_idx" ON "desktop_local_agent_sessions" USING btree ("organization_id","user_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_local_agent_sessions_project_idx" ON "desktop_local_agent_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_local_agent_sessions_run_idx" ON "desktop_local_agent_sessions" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_local_agent_sessions_task_idx" ON "desktop_local_agent_sessions" USING btree ("task_id");