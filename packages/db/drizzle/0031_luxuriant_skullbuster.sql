CREATE TABLE "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"release_id" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	"error_payload_json" jsonb NOT NULL,
	"relevant_commit_sha" text NOT NULL,
	"reproduction_ref" text NOT NULL,
	"evidence_json" jsonb NOT NULL,
	"operation_key" text NOT NULL,
	"fix_run_id" text,
	"resolution_release_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_source_check" CHECK (source in ('grafana_faro', 'grafana_loki', 'synthetic_check', 'user_report')),
	CONSTRAINT "incidents_status_check" CHECK (status in ('open', 'fix_in_progress', 'resolved')),
	CONSTRAINT "incidents_error_payload_size_check" CHECK (pg_column_size(error_payload_json) <= 65536),
	CONSTRAINT "incidents_evidence_size_check" CHECK (pg_column_size(evidence_json) <= 262144)
);
--> statement-breakpoint
CREATE TABLE "artifact_retention" (
	"artifact_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"retention_class" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_deletions" (
	"project_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"operation_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"snapshots_status" text DEFAULT 'pending' NOT NULL,
	"git_status" text DEFAULT 'pending' NOT NULL,
	"objects_status" text DEFAULT 'pending' NOT NULL,
	"postgres_status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"requested_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "project_deletions_status_check" CHECK ("project_deletions"."status" in ('queued', 'running', 'failed', 'completed')),
	CONSTRAINT "project_deletions_targets_check" CHECK ("project_deletions"."snapshots_status" in ('pending', 'verified') and "project_deletions"."git_status" in ('pending', 'verified') and "project_deletions"."objects_status" in ('pending', 'verified') and "project_deletions"."postgres_status" in ('pending', 'verified')),
	CONSTRAINT "project_deletions_lease_check" CHECK (("project_deletions"."lease_owner" is null) = ("project_deletions"."lease_expires_at" is null)),
	CONSTRAINT "project_deletions_completion_check" CHECK (("project_deletions"."status" = 'completed') = ("project_deletions"."snapshots_status" = 'verified' and "project_deletions"."git_status" = 'verified' and "project_deletions"."objects_status" = 'verified' and "project_deletions"."postgres_status" = 'verified' and "project_deletions"."completed_at" is not null) and ("project_deletions"."status" = 'completed' or "project_deletions"."completed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "model_completion_journal" DROP CONSTRAINT "model_completion_journal_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "model_completion_journal" DROP CONSTRAINT "model_completion_journal_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "model_completion_journal" DROP CONSTRAINT "model_completion_journal_task_id_agent_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "model_completion_journal" DROP CONSTRAINT "model_completion_journal_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "run_credit_accounts" DROP CONSTRAINT "run_credit_accounts_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "run_credit_ceiling_adjustments" DROP CONSTRAINT "run_credit_ceiling_adjustments_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "run_credit_ceiling_adjustments" DROP CONSTRAINT "run_credit_ceiling_adjustments_approval_id_approvals_id_fk";
--> statement-breakpoint
ALTER TABLE "sandbox_snapshot_measurements" DROP CONSTRAINT "sandbox_snapshot_measurements_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "agent_events" DROP CONSTRAINT "agent_events_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_events" DROP CONSTRAINT "agent_events_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_events" DROP CONSTRAINT "agent_events_phase_id_agent_phases_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_events" DROP CONSTRAINT "agent_events_task_id_agent_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_events" DROP CONSTRAINT "agent_events_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_task_id_agent_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "run_event_counters" DROP CONSTRAINT "run_event_counters_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "test_cases" DROP CONSTRAINT "test_cases_test_run_id_test_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "test_runs" DROP CONSTRAINT "test_runs_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "test_runs" DROP CONSTRAINT "test_runs_task_id_agent_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "verification_results" DROP CONSTRAINT "verification_results_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "verification_results" DROP CONSTRAINT "verification_results_task_id_agent_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "branches" DROP CONSTRAINT "branches_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "branches" DROP CONSTRAINT "branches_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "environments" DROP CONSTRAINT "environments_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "environments" DROP CONSTRAINT "environments_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "preview_shares" DROP CONSTRAINT "preview_shares_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "preview_shares" DROP CONSTRAINT "preview_shares_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "project_contracts" DROP CONSTRAINT "project_contracts_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "project_contracts" DROP CONSTRAINT "project_contracts_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "agent_phases" DROP CONSTRAINT "agent_phases_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "agent_tasks" DROP CONSTRAINT "agent_tasks_phase_id_agent_phases_id_fk";
--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_task_id_agent_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "decisions" DROP CONSTRAINT "decisions_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "decisions" DROP CONSTRAINT "decisions_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "desktop_local_agent_sessions" DROP CONSTRAINT "desktop_local_agent_sessions_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "desktop_local_agent_sessions" DROP CONSTRAINT "desktop_local_agent_sessions_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "desktop_local_agent_sessions" DROP CONSTRAINT "desktop_local_agent_sessions_task_id_agent_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "desktop_local_agent_sessions" DROP CONSTRAINT "desktop_local_agent_sessions_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "specifications" DROP CONSTRAINT "specifications_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "specifications" DROP CONSTRAINT "specifications_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_release_id_releases_id_fk";
--> statement-breakpoint
ALTER TABLE "releases" DROP CONSTRAINT "releases_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "releases" DROP CONSTRAINT "releases_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "synthetic_checks" DROP CONSTRAINT "synthetic_checks_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "synthetic_checks" DROP CONSTRAINT "synthetic_checks_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "github_imports" DROP CONSTRAINT "github_imports_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "integration_connections" DROP CONSTRAINT "integration_connections_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "integration_connections" DROP CONSTRAINT "integration_connections_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "secret_metadata" DROP CONSTRAINT "secret_metadata_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "secret_metadata" DROP CONSTRAINT "secret_metadata_project_tenant_fk";
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_fix_run_id_agent_runs_id_fk" FOREIGN KEY ("fix_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolution_release_id_releases_id_fk" FOREIGN KEY ("resolution_release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_retention" ADD CONSTRAINT "artifact_retention_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_retention" ADD CONSTRAINT "artifact_retention_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_deletions" ADD CONSTRAINT "project_deletions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_deletions" ADD CONSTRAINT "project_deletions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_org_operation_idx" ON "incidents" USING btree ("organization_id","operation_key");--> statement-breakpoint
CREATE INDEX "incidents_project_status_created_idx" ON "incidents" USING btree ("project_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "artifact_retention_expiry_idx" ON "artifact_retention" USING btree ("expires_at","artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_deletions_org_operation_idx" ON "project_deletions" USING btree ("organization_id","operation_key");--> statement-breakpoint
CREATE INDEX "project_deletions_poll_idx" ON "project_deletions" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
ALTER TABLE "model_completion_journal" ADD CONSTRAINT "model_completion_journal_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_completion_journal" ADD CONSTRAINT "model_completion_journal_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_completion_journal" ADD CONSTRAINT "model_completion_journal_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_completion_journal" ADD CONSTRAINT "model_completion_journal_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_credit_accounts" ADD CONSTRAINT "run_credit_accounts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_credit_ceiling_adjustments" ADD CONSTRAINT "run_credit_ceiling_adjustments_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_credit_ceiling_adjustments" ADD CONSTRAINT "run_credit_ceiling_adjustments_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_snapshot_measurements" ADD CONSTRAINT "sandbox_snapshot_measurements_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_phase_id_agent_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."agent_phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_event_counters" ADD CONSTRAINT "run_event_counters_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_shares" ADD CONSTRAINT "preview_shares_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_shares" ADD CONSTRAINT "preview_shares_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contracts" ADD CONSTRAINT "project_contracts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contracts" ADD CONSTRAINT "project_contracts_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_phases" ADD CONSTRAINT "agent_phases_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_phase_id_agent_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."agent_phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_local_agent_sessions" ADD CONSTRAINT "desktop_local_agent_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_local_agent_sessions" ADD CONSTRAINT "desktop_local_agent_sessions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_local_agent_sessions" ADD CONSTRAINT "desktop_local_agent_sessions_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_local_agent_sessions" ADD CONSTRAINT "desktop_local_agent_sessions_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_checks" ADD CONSTRAINT "synthetic_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_checks" ADD CONSTRAINT "synthetic_checks_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_imports" ADD CONSTRAINT "github_imports_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_metadata" ADD CONSTRAINT "secret_metadata_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_metadata" ADD CONSTRAINT "secret_metadata_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;