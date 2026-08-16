CREATE TABLE "builder_session_transcripts" (
	"run_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"version" integer NOT NULL,
	"transcript_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builder_session_transcripts_run_id_task_id_pk" PRIMARY KEY("run_id","task_id"),
	CONSTRAINT "builder_session_transcripts_version_check" CHECK ("builder_session_transcripts"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "conversation_context_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"source_run_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"context_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_context_content_hash_check" CHECK ("conversation_context_artifacts"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"created_by" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_title_length_check" CHECK (char_length("conversations"."title") between 1 and 160)
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "conversation_run_number" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_id_org_idx" ON "conversations" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_id_org_idx" ON "agent_runs" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "conversations" (
	"id",
	"organization_id",
	"project_id",
	"created_by",
	"title",
	"created_at",
	"updated_at"
)
SELECT
	'conv_' || substring(run."id" from 5),
	run."organization_id",
	run."project_id",
	run."started_by",
	coalesce(
		nullif(left((
			SELECT event."payload_json" ->> 'content'
			FROM "agent_events" event
			WHERE event."run_id" = run."id"
				AND event."type" = 'message.user'
			ORDER BY event."sequence" ASC
			LIMIT 1
		), 160), ''),
		'Conversation ' || right(run."id", 8)
	),
	run."started_at",
	coalesce(run."completed_at", run."started_at")
FROM "agent_runs" run;--> statement-breakpoint
UPDATE "agent_runs"
SET
	"conversation_id" = 'conv_' || substring("id" from 5),
	"conversation_run_number" = 1;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "conversation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "conversation_run_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "builder_session_transcripts" ADD CONSTRAINT "builder_session_transcripts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_session_transcripts" ADD CONSTRAINT "builder_session_transcripts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_context_artifacts" ADD CONSTRAINT "conversation_context_artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_context_artifacts" ADD CONSTRAINT "conversation_context_artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_context_artifacts" ADD CONSTRAINT "conversation_context_conversation_tenant_fk" FOREIGN KEY ("conversation_id","organization_id") REFERENCES "public"."conversations"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_context_artifacts" ADD CONSTRAINT "conversation_context_run_tenant_fk" FOREIGN KEY ("run_id","organization_id") REFERENCES "public"."agent_runs"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_context_artifacts" ADD CONSTRAINT "conversation_context_source_run_tenant_fk" FOREIGN KEY ("source_run_id","organization_id") REFERENCES "public"."agent_runs"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_context_artifacts" ADD CONSTRAINT "conversation_context_artifacts_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_context_artifacts_id_org_idx" ON "conversation_context_artifacts" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_context_run_idx" ON "conversation_context_artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "conversations_project_updated_idx" ON "conversations" USING btree ("project_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_tenant_fk" FOREIGN KEY ("conversation_id","organization_id") REFERENCES "public"."conversations"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_conversation_order_idx" ON "agent_runs" USING btree ("conversation_id","conversation_run_number");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_conversation_active_idx" ON "agent_runs" USING btree ("conversation_id") WHERE "agent_runs"."status" in ('queued', 'running', 'paused', 'waiting_for_approval');--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_run_number_check" CHECK ("agent_runs"."conversation_run_number" >= 1);
