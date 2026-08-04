CREATE TABLE "agent_events" (
	"id" text NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"type" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"visibility" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_events_pk" PRIMARY KEY("id","occurred_at"),
	CONSTRAINT "agent_events_visibility_check" CHECK (visibility in ('user', 'internal', 'support')),
	CONSTRAINT "agent_events_payload_size_check" CHECK (pg_column_size(payload_json) <= 65536)
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"task_id" text,
	"type" text NOT NULL,
	"storage_ref" text NOT NULL,
	"content_hash" text NOT NULL,
	"metadata_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_event_counters" (
	"run_id" text PRIMARY KEY NOT NULL,
	"last_sequence" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"test_run_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"duration_ms" integer,
	"evidence_artifact_id" text,
	"error_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "test_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text,
	"commit_sha" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"summary_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "verification_results" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text,
	"commit_sha" text NOT NULL,
	"decision" text NOT NULL,
	"criteria_results_json" jsonb NOT NULL,
	"risks_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"branch_id" text,
	"provider" text NOT NULL,
	"provider_workspace_id" text,
	"status" text NOT NULL,
	"resource_profile" text NOT NULL,
	"snapshot_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone,
	"terminated_at" timestamp with time zone,
	CONSTRAINT "workspaces_status_check" CHECK (status in ('requested', 'provisioning', 'started', 'ready', 'active', 'checkpointing', 'idle', 'terminated'))
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"head_commit_sha" text,
	"base_branch_id" text,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"deployment_provider" text,
	"database_connection_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"detected_framework" text,
	"contract_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"source_type" text NOT NULL,
	"support_level" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "projects_support_level_check" CHECK (support_level in ('compatible', 'verified', 'managed'))
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"provider" text NOT NULL,
	"internal_repo_ref" text NOT NULL,
	"external_repo_ref" text,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"sync_policy" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_phases" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"acceptance_criteria_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"branch_id" text,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"specification_id" text,
	"temporal_workflow_id" text,
	"started_by" text NOT NULL,
	"budget_json" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_runs_mode_check" CHECK (mode in ('ask', 'prototype', 'build', 'fix', 'autonomous'))
);
--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"phase_id" text NOT NULL,
	"parent_task_id" text,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"risk_level" text NOT NULL,
	"base_commit_sha" text,
	"output_commit_sha" text,
	"acceptance_criteria_json" jsonb NOT NULL,
	"dependencies_json" jsonb NOT NULL,
	"assigned_agent_role" text,
	CONSTRAINT "agent_tasks_status_check" CHECK (status in ('queued', 'blocked', 'ready', 'running', 'waiting_for_approval', 'verifying', 'repairing', 'passed', 'failed', 'cancelled', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"request_json" jsonb NOT NULL,
	"response_json" jsonb,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"specification_id" text,
	"question" text NOT NULL,
	"decision" text NOT NULL,
	"rationale" text,
	"made_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "specifications" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"content_json" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"release_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_deployment_id" text,
	"status" text NOT NULL,
	"url" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"rollback_of_deployment_id" text
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"specification_id" text,
	"status" text NOT NULL,
	"evidence_manifest_artifact_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "synthetic_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"name" text NOT NULL,
	"schedule" text NOT NULL,
	"status" text NOT NULL,
	"last_run_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"metadata_json" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"credential_ref" text,
	"configuration_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_metadata" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text,
	"environment_id" text,
	"name" text NOT NULL,
	"encrypted_value_ref" text NOT NULL,
	"created_by" text NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_event_counters" ADD CONSTRAINT "run_event_counters_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_evidence_artifact_id_artifacts_id_fk" FOREIGN KEY ("evidence_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_base_branch_id_branches_id_fk" FOREIGN KEY ("base_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contracts" ADD CONSTRAINT "project_contracts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contracts" ADD CONSTRAINT "project_contracts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_phases" ADD CONSTRAINT "agent_phases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_phases" ADD CONSTRAINT "agent_phases_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_specification_id_specifications_id_fk" FOREIGN KEY ("specification_id") REFERENCES "public"."specifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_phase_id_agent_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."agent_phases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_parent_task_id_agent_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_specification_id_specifications_id_fk" FOREIGN KEY ("specification_id") REFERENCES "public"."specifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_rollback_of_deployment_id_deployments_id_fk" FOREIGN KEY ("rollback_of_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_specification_id_specifications_id_fk" FOREIGN KEY ("specification_id") REFERENCES "public"."specifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_evidence_manifest_artifact_id_artifacts_id_fk" FOREIGN KEY ("evidence_manifest_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_checks" ADD CONSTRAINT "synthetic_checks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_checks" ADD CONSTRAINT "synthetic_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_checks" ADD CONSTRAINT "synthetic_checks_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_metadata" ADD CONSTRAINT "secret_metadata_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_metadata" ADD CONSTRAINT "secret_metadata_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_metadata" ADD CONSTRAINT "secret_metadata_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_metadata" ADD CONSTRAINT "secret_metadata_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_events_org_occurred_at_idx" ON "agent_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "artifacts_project_created_at_idx" ON "artifacts" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "artifacts_run_idx" ON "artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "test_cases_test_run_idx" ON "test_cases" USING btree ("test_run_id");--> statement-breakpoint
CREATE INDEX "test_runs_run_idx" ON "test_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "verification_results_run_idx" ON "verification_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "workspaces_org_status_idx" ON "workspaces" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "workspaces_project_idx" ON "workspaces" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_project_name_idx" ON "branches" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_project_name_idx" ON "environments" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "project_contracts_project_version_idx" ON "project_contracts" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_slug_idx" ON "projects" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "repositories_project_idx" ON "repositories" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_phases_run_sequence_idx" ON "agent_phases" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "agent_runs_project_started_at_idx" ON "agent_runs" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_org_started_at_idx" ON "agent_runs" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_phase_idx" ON "agent_tasks" USING btree ("phase_id");--> statement-breakpoint
CREATE INDEX "approvals_run_status_idx" ON "approvals" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "decisions_project_specification_idx" ON "decisions" USING btree ("project_id","specification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "specifications_project_version_idx" ON "specifications" USING btree ("project_id","version");--> statement-breakpoint
CREATE INDEX "deployments_release_idx" ON "deployments" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "releases_project_created_at_idx" ON "releases" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "releases_environment_idx" ON "releases" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "synthetic_checks_project_environment_idx" ON "synthetic_checks" USING btree ("project_id","environment_id");--> statement-breakpoint
CREATE INDEX "audit_events_org_occurred_at_idx" ON "audit_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "integration_connections_org_project_idx" ON "integration_connections" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "secret_metadata_org_project_idx" ON "secret_metadata" USING btree ("organization_id","project_id");--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- agent_events partitioning (plan 01 FND-6; master plan §5.2, PRD §14.4)
--
-- Hand-written: drizzle-kit cannot author PARTITION BY, so the CREATE TABLE
-- above carries the clause and everything below is maintained here by hand.
-- The snapshot in meta/ records only columns and constraints, which is all a
-- future `drizzle-kit generate` diffs, so partitioning stays invisible to it —
-- this file is the only place that knows.
--
-- Why partition at all: agent_events is the hot table (10M rows expected,
-- 100M ceiling), and retention is enforced by dropping a month rather than by
-- DELETE-ing rows out of a live index (plan 10 OPS-14). Range on occurred_at
-- also lets the (organization_id, occurred_at) index prune to one month.
-- ---------------------------------------------------------------------------
CREATE FUNCTION create_event_partition(starts date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
	partition_name text := format('agent_events_%s', to_char(starts, 'YYYY_MM'));
BEGIN
	EXECUTE format(
		'CREATE TABLE IF NOT EXISTS %I PARTITION OF agent_events FOR VALUES FROM (%L) TO (%L)',
		partition_name, starts, starts + interval '1 month'
	);
	-- Unique per partition, not globally: Postgres requires the partition key
	-- in every unique index on a partitioned table, and (run_id, sequence,
	-- occurred_at) would not be the constraint the event contract needs.
	-- Global uniqueness comes from run_event_counters being the single
	-- allocator of sequence numbers (nextEventSequence); this index is what
	-- catches a replayed insert inside the month it belongs to.
	EXECUTE format(
		'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (run_id, sequence)',
		partition_name || '_run_sequence_idx', partition_name
	);
	RETURN partition_name;
END;
$$;--> statement-breakpoint
-- Called monthly by the retention job (plan 10 OPS-14 owns the schedule; this
-- migration owns the SQL). Idempotent, so a re-run or an overlapping cron tick
-- is a no-op rather than an error.
CREATE FUNCTION create_next_partition() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
	latest date;
BEGIN
	-- The newest existing month, read from the partition names rather than from
	-- their bounds: pg_get_expr(relpartbound) would have to be parsed back.
	SELECT max(to_date(substring(child.relname FROM '\d{4}_\d{2}$'), 'YYYY_MM'))
		INTO latest
		FROM pg_inherits
		JOIN pg_class child ON child.oid = pg_inherits.inhrelid
		JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
		WHERE parent.relname = 'agent_events';

	RETURN create_event_partition(
		(coalesce(latest, date_trunc('month', now())::date) + interval '1 month')::date
	);
END;
$$;--> statement-breakpoint
-- Twelve months of runway from the P0 launch month. There is deliberately no
-- DEFAULT partition: an event landing in one would be retained past its TTL and
-- invisible to the month-at-a-time archiver, so an unpartitioned month must
-- fail loudly at insert time instead.
SELECT create_event_partition('2026-08-01');--> statement-breakpoint
SELECT create_event_partition('2026-09-01');--> statement-breakpoint
SELECT create_event_partition('2026-10-01');--> statement-breakpoint
SELECT create_event_partition('2026-11-01');--> statement-breakpoint
SELECT create_event_partition('2026-12-01');--> statement-breakpoint
SELECT create_event_partition('2027-01-01');--> statement-breakpoint
SELECT create_event_partition('2027-02-01');--> statement-breakpoint
SELECT create_event_partition('2027-03-01');--> statement-breakpoint
SELECT create_event_partition('2027-04-01');--> statement-breakpoint
SELECT create_event_partition('2027-05-01');--> statement-breakpoint
SELECT create_event_partition('2027-06-01');--> statement-breakpoint
SELECT create_event_partition('2027-07-01');