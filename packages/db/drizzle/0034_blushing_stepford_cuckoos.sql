CREATE TABLE "production_health_results" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"release_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"status" text NOT NULL,
	"evidence_artifact_id" text NOT NULL,
	"result_json" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "production_health_results_status_check" CHECK ("production_health_results"."status" in ('healthy','failed'))
);
--> statement-breakpoint
CREATE TABLE "release_annotations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"release_id" text NOT NULL,
	"deployment_id" text,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"link" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "release_annotations_provider_check" CHECK ("release_annotations"."provider" in ('grafana','posthog'))
);
--> statement-breakpoint
CREATE TABLE "synthetic_check_results" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"release_id" text NOT NULL,
	"synthetic_check_id" text NOT NULL,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	"evidence_artifact_ids_json" jsonb NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "synthetic_check_results_status_check" CHECK ("synthetic_check_results"."status" in ('passed','failed'))
);
--> statement-breakpoint
ALTER TABLE "production_health_results" ADD CONSTRAINT "production_health_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_health_results" ADD CONSTRAINT "production_health_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_health_results" ADD CONSTRAINT "production_health_results_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_health_results" ADD CONSTRAINT "production_health_results_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_health_results" ADD CONSTRAINT "production_health_results_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_health_results" ADD CONSTRAINT "production_health_results_evidence_artifact_id_artifacts_id_fk" FOREIGN KEY ("evidence_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_health_results" ADD CONSTRAINT "production_health_results_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_annotations" ADD CONSTRAINT "release_annotations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_annotations" ADD CONSTRAINT "release_annotations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_annotations" ADD CONSTRAINT "release_annotations_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_annotations" ADD CONSTRAINT "release_annotations_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_annotations" ADD CONSTRAINT "release_annotations_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_check_results" ADD CONSTRAINT "synthetic_check_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_check_results" ADD CONSTRAINT "synthetic_check_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_check_results" ADD CONSTRAINT "synthetic_check_results_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_check_results" ADD CONSTRAINT "synthetic_check_results_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_check_results" ADD CONSTRAINT "synthetic_check_results_synthetic_check_id_synthetic_checks_id_fk" FOREIGN KEY ("synthetic_check_id") REFERENCES "public"."synthetic_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_check_results" ADD CONSTRAINT "synthetic_check_results_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_health_results_deployment_evidence_idx" ON "production_health_results" USING btree ("organization_id","deployment_id","evidence_artifact_id");--> statement-breakpoint
CREATE INDEX "production_health_results_project_occurred_idx" ON "production_health_results" USING btree ("organization_id","project_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "release_annotations_provider_kind_release_idx" ON "release_annotations" USING btree ("organization_id","release_id","provider","kind");--> statement-breakpoint
CREATE INDEX "release_annotations_project_occurred_idx" ON "release_annotations" USING btree ("organization_id","project_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "synthetic_check_results_check_completed_idx" ON "synthetic_check_results" USING btree ("organization_id","synthetic_check_id","completed_at");--> statement-breakpoint
CREATE INDEX "synthetic_check_results_project_completed_idx" ON "synthetic_check_results" USING btree ("organization_id","project_id","completed_at");