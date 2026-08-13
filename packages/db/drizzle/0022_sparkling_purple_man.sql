CREATE TABLE "sandbox_snapshot_measurements" (
	"provider_snapshot_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"logical_bytes" numeric NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_reconciliation_corrections" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_key" text NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text,
	"run_id" text,
	"task_id" text,
	"category" text NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"target_quantity" numeric NOT NULL,
	"delta_quantity" numeric NOT NULL,
	"event_json" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "usage_reconciliation_corrections_category_check" CHECK (category in ('model_input_tokens', 'model_output_tokens', 'model_cached_tokens', 'sandbox_cpu_seconds', 'sandbox_mem_gib_seconds', 'storage_gib_hours', 'deploy_provider', 'artifact_storage')),
	CONSTRAINT "usage_reconciliation_corrections_status_check" CHECK (status in ('pending', 'delivered'))
);
--> statement-breakpoint
ALTER TABLE "usage_outbox" DROP CONSTRAINT "usage_outbox_status_check";--> statement-breakpoint
ALTER TABLE "usage_outbox" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_snapshot_measurements" ADD CONSTRAINT "sandbox_snapshot_measurements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_snapshot_measurements" ADD CONSTRAINT "sandbox_snapshot_measurements_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reconciliation_corrections" ADD CONSTRAINT "usage_reconciliation_corrections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_snapshot_measurements_project_expiry_idx" ON "sandbox_snapshot_measurements" USING btree ("organization_id","project_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_reconciliation_corrections_operation_idx" ON "usage_reconciliation_corrections" USING btree ("operation_key");--> statement-breakpoint
CREATE INDEX "usage_reconciliation_corrections_pending_idx" ON "usage_reconciliation_corrections" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "usage_outbox" ADD CONSTRAINT "usage_outbox_status_check" CHECK (status in ('pending', 'published', 'delivered'));