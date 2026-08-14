CREATE TABLE "sandbox_capacity_admissions" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"purpose" text NOT NULL,
	"operation_key" text NOT NULL,
	"decision" text NOT NULL,
	"queue_position" integer,
	"requested_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone,
	"active" boolean DEFAULT false NOT NULL,
	"released_at" timestamp with time zone,
	"lease_owner_id" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_capacity_decision_check" CHECK (decision in ('admitted', 'queued')),
	CONSTRAINT "sandbox_capacity_decision_shape_check" CHECK ((
        ("sandbox_capacity_admissions"."decision" = 'admitted' and "sandbox_capacity_admissions"."deadline_at" is not null and "sandbox_capacity_admissions"."queue_position" is null)
        or
        ("sandbox_capacity_admissions"."decision" = 'queued' and "sandbox_capacity_admissions"."deadline_at" is null and "sandbox_capacity_admissions"."queue_position" > 0 and not "sandbox_capacity_admissions"."active")
      )),
	CONSTRAINT "sandbox_capacity_lease_shape_check" CHECK (num_nonnulls("sandbox_capacity_admissions"."lease_owner_id", "sandbox_capacity_admissions"."lease_token", "sandbox_capacity_admissions"."lease_expires_at") in (0, 3) and ("sandbox_capacity_admissions"."lease_token" is null or "sandbox_capacity_admissions"."active"))
);
--> statement-breakpoint
ALTER TABLE "sandbox_capacity_admissions" ADD CONSTRAINT "sandbox_capacity_admissions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_capacity_admissions" ADD CONSTRAINT "sandbox_capacity_admissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_capacity_admissions" ADD CONSTRAINT "sandbox_capacity_admissions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_capacity_admissions" ADD CONSTRAINT "sandbox_capacity_admissions_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_capacity_operation_key_idx" ON "sandbox_capacity_admissions" USING btree ("operation_key");--> statement-breakpoint
CREATE INDEX "sandbox_capacity_active_global_idx" ON "sandbox_capacity_admissions" USING btree ("active","deadline_at","workspace_id");--> statement-breakpoint
CREATE INDEX "sandbox_capacity_active_org_idx" ON "sandbox_capacity_admissions" USING btree ("organization_id","active","requested_at","workspace_id");--> statement-breakpoint
CREATE INDEX "sandbox_capacity_expired_lease_idx" ON "sandbox_capacity_admissions" USING btree ("active","deadline_at","lease_expires_at");