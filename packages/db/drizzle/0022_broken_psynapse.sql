CREATE TABLE "github_import_outbox" (
	"project_id" text NOT NULL,
	"stage" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "github_import_outbox_stage_check" CHECK ("github_import_outbox"."stage" in ('queued', 'scan_pending')),
	CONSTRAINT "github_import_outbox_status_check" CHECK ("github_import_outbox"."status" in ('pending', 'published'))
);
--> statement-breakpoint
CREATE TABLE "github_imports" (
	"project_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"repo" text NOT NULL,
	"branch" text NOT NULL,
	"operation_key" text NOT NULL,
	"status" text NOT NULL,
	"external_repo_ref" text,
	"head_commit_sha" text,
	"scan_id" text,
	"error_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "github_imports_status_check" CHECK ("github_imports"."status" in ('queued', 'mirroring', 'scan_pending', 'scan_accepted', 'failed')),
	CONSTRAINT "github_imports_error_code_check" CHECK ("github_imports"."error_code" is null or "github_imports"."error_code" in ('github_unavailable', 'repository_not_found', 'branch_not_found', 'mirror_failed', 'scan_unavailable'))
);
--> statement-breakpoint
ALTER TABLE "github_import_outbox" ADD CONSTRAINT "github_import_outbox_project_id_github_imports_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."github_imports"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_imports" ADD CONSTRAINT "github_imports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_imports" ADD CONSTRAINT "github_imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_imports" ADD CONSTRAINT "github_imports_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_import_outbox_project_stage_idx" ON "github_import_outbox" USING btree ("project_id","stage");--> statement-breakpoint
CREATE INDEX "github_import_outbox_pending_idx" ON "github_import_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "github_imports_org_operation_key_idx" ON "github_imports" USING btree ("organization_id","operation_key");