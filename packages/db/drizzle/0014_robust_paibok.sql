CREATE TABLE "accounting_leader_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"cursor_run_id" text
);
--> statement-breakpoint
CREATE TABLE "model_completion_journal" (
	"completion_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text,
	"request_fingerprint" text NOT NULL,
	"claim_owner" text,
	"claim_expires_at" timestamp with time zone,
	"reserved_credits" numeric(12, 4) NOT NULL,
	"state" text NOT NULL,
	"response_json" jsonb,
	"terminal_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_completion_journal_state_check" CHECK (state in ('claimed', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "run_credit_accounts" (
	"run_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"base_ceiling" numeric(12, 4) NOT NULL,
	"pricing_version" text NOT NULL,
	"pricing_snapshot_json" jsonb NOT NULL,
	"used_credits" numeric(12, 4) DEFAULT '0' NOT NULL,
	"reserved_credits" numeric(12, 4) DEFAULT '0' NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_credit_ceiling_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"absolute_ceiling" numeric(12, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ledger_row_id" text NOT NULL,
	"event_json" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "usage_outbox_status_check" CHECK (status in ('pending', 'published'))
);
--> statement-breakpoint
ALTER TABLE "model_completion_journal" ADD CONSTRAINT "model_completion_journal_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_completion_journal" ADD CONSTRAINT "model_completion_journal_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_completion_journal" ADD CONSTRAINT "model_completion_journal_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_completion_journal" ADD CONSTRAINT "model_completion_journal_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_completion_journal" ADD CONSTRAINT "model_completion_journal_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_credit_accounts" ADD CONSTRAINT "run_credit_accounts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_credit_accounts" ADD CONSTRAINT "run_credit_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_credit_ceiling_adjustments" ADD CONSTRAINT "run_credit_ceiling_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_credit_ceiling_adjustments" ADD CONSTRAINT "run_credit_ceiling_adjustments_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_credit_ceiling_adjustments" ADD CONSTRAINT "run_credit_ceiling_adjustments_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "usage_outbox" ADD CONSTRAINT "usage_outbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "usage_outbox" ADD CONSTRAINT "usage_outbox_ledger_row_id_usage_ledger_id_fk" FOREIGN KEY ("ledger_row_id") REFERENCES "public"."usage_ledger"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "model_completion_journal_run_idx" ON "model_completion_journal" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "run_credit_accounts_org_idx" ON "run_credit_accounts" USING btree ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "run_credit_ceiling_adjustments_operation_idx" ON "run_credit_ceiling_adjustments" USING btree ("run_id","operation_key");
--> statement-breakpoint
CREATE INDEX "run_credit_ceiling_adjustments_run_created_idx" ON "run_credit_ceiling_adjustments" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_outbox_ledger_row_idx" ON "usage_outbox" USING btree ("ledger_row_id");
--> statement-breakpoint
CREATE INDEX "usage_outbox_pending_idx" ON "usage_outbox" USING btree ("status","next_attempt_at");
--> statement-breakpoint
CREATE TRIGGER "run_credit_ceiling_adjustments_append_only"
BEFORE UPDATE OR DELETE ON "run_credit_ceiling_adjustments"
FOR EACH STATEMENT EXECUTE FUNCTION zapp_append_only();
--> statement-breakpoint
CREATE TRIGGER "run_credit_ceiling_adjustments_append_only_truncate"
BEFORE TRUNCATE ON "run_credit_ceiling_adjustments"
FOR EACH STATEMENT EXECUTE FUNCTION zapp_append_only();
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zapp') THEN
		REVOKE UPDATE, DELETE, TRUNCATE ON public.run_credit_ceiling_adjustments FROM zapp;
	END IF;
END;
$$;
