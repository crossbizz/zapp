CREATE TABLE "preview_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"token_hash" text NOT NULL,
	"key_version" integer NOT NULL,
	"policy" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preview_shares_policy_check" CHECK (policy in ('org', 'anyone_with_link')),
	CONSTRAINT "preview_shares_key_version_check" CHECK (key_version > 0),
	CONSTRAINT "preview_shares_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id"),
	CONSTRAINT "preview_shares_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id"),
	CONSTRAINT "preview_shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id"),
	CONSTRAINT "preview_shares_project_tenant_fk" FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects"("id", "organization_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "preview_shares_org_operation_idx" ON "preview_shares" ("organization_id", "operation_key");
--> statement-breakpoint
CREATE INDEX "preview_shares_org_project_idx" ON "preview_shares" ("organization_id", "project_id", "id");
--> statement-breakpoint
CREATE INDEX "preview_shares_org_workspace_idx" ON "preview_shares" ("organization_id", "workspace_id", "id");
