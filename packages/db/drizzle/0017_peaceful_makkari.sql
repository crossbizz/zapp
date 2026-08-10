ALTER TABLE "workspaces" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "environment" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "image_tag" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "preview_monitor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "preview_monitor_owner_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "preview_monitor_lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workspaces_preview_monitor_idx" ON "workspaces" USING btree ("preview_monitor_enabled","preview_monitor_lease_expires_at");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_attachment_complete_check" CHECK (num_nonnulls("workspaces"."run_id", "workspaces"."task_id", "workspaces"."purpose", "workspaces"."environment", "workspaces"."image_tag") in (0, 5));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_preview_monitor_lease_check" CHECK (("workspaces"."preview_monitor_owner_id" is null) = ("workspaces"."preview_monitor_lease_expires_at" is null));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_preview_monitor_disabled_check" CHECK ("workspaces"."preview_monitor_enabled" or ("workspaces"."preview_monitor_owner_id" is null and "workspaces"."preview_monitor_lease_expires_at" is null));