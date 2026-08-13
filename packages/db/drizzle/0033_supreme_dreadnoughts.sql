CREATE TABLE "deployment_action_requests" (
	"organization_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"action" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone,
	CONSTRAINT "deployment_action_requests_resource_check" CHECK ("deployment_action_requests"."resource_type" in ('release','deployment')),
	CONSTRAINT "deployment_action_requests_status_check" CHECK ("deployment_action_requests"."status" in ('pending','dispatched'))
);
--> statement-breakpoint
CREATE TABLE "deployment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"elapsed_ms" integer NOT NULL,
	"summary" text NOT NULL,
	"evidence_artifact_id" text,
	"terminal_success_json" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deployment_events_sequence_check" CHECK ("deployment_events"."sequence" >= 0),
	CONSTRAINT "deployment_events_elapsed_ms_check" CHECK ("deployment_events"."elapsed_ms" >= 0),
	CONSTRAINT "deployment_events_stage_check" CHECK ("deployment_events"."stage" in ('readiness_check','build_artifact','configure_secrets','apply_migrations','provision_runtime','start_services','production_health_check','go_live')),
	CONSTRAINT "deployment_events_status_check" CHECK ("deployment_events"."status" in ('running','passed','failed'))
);
--> statement-breakpoint
CREATE TABLE "environment_domains" (
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"hostname" text NOT NULL,
	"operation_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_domain_reference" text,
	"status" text NOT NULL,
	"dns_instructions_json" jsonb NOT NULL,
	"routing_json" jsonb NOT NULL,
	"detail" text,
	"verification_attempt" integer NOT NULL,
	CONSTRAINT "environment_domains_status_check" CHECK ("environment_domains"."status" in ('pending_dns','verifying','active','failed')),
	CONSTRAINT "environment_domains_attempt_check" CHECK ("environment_domains"."verification_attempt" >= 0)
);
--> statement-breakpoint
ALTER TABLE "deployment_action_requests" ADD CONSTRAINT "deployment_action_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_evidence_artifact_id_artifacts_id_fk" FOREIGN KEY ("evidence_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_domains" ADD CONSTRAINT "environment_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_domains" ADD CONSTRAINT "environment_domains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_domains" ADD CONSTRAINT "environment_domains_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_domains" ADD CONSTRAINT "environment_domains_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_action_requests_org_operation_idx" ON "deployment_action_requests" USING btree ("organization_id","operation_key");--> statement-breakpoint
CREATE INDEX "deployment_action_requests_resource_idx" ON "deployment_action_requests" USING btree ("organization_id","resource_type","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_events_deployment_sequence_idx" ON "deployment_events" USING btree ("organization_id","deployment_id","sequence");--> statement-breakpoint
CREATE INDEX "deployment_events_replay_idx" ON "deployment_events" USING btree ("organization_id","deployment_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_domains_environment_hostname_idx" ON "environment_domains" USING btree ("organization_id","environment_id","hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_domains_operation_idx" ON "environment_domains" USING btree ("organization_id","operation_key");--> statement-breakpoint
CREATE INDEX "environment_domains_project_idx" ON "environment_domains" USING btree ("organization_id","project_id","environment_id");