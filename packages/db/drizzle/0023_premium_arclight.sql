ALTER TABLE "usage_reconciliation_corrections" DROP CONSTRAINT "usage_reconciliation_corrections_status_check";--> statement-breakpoint
ALTER TABLE "usage_reconciliation_corrections" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "usage_operation_key" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "usage_last_sample_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "usage_last_cpu_micros" bigint;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "usage_cpu_seconds" numeric(24, 6);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "usage_memory_gib_seconds" numeric(24, 6);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "usage_cpu_second_usd" numeric(18, 12);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "usage_memory_gib_second_usd" numeric(18, 12);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "usage_credits_per_usd" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "usage_finalized_at" timestamp with time zone;--> statement-breakpoint
UPDATE "usage_reconciliation_corrections" SET "status" = 'pending' WHERE "status" = 'delivered';--> statement-breakpoint
ALTER TABLE "usage_reconciliation_corrections" ADD CONSTRAINT "usage_reconciliation_corrections_status_check" CHECK (status in ('pending', 'confirmed'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_usage_state_complete_check" CHECK (("workspaces"."usage_operation_key" is null and num_nonnulls("workspaces"."usage_last_sample_at", "workspaces"."usage_last_cpu_micros", "workspaces"."usage_cpu_seconds", "workspaces"."usage_memory_gib_seconds", "workspaces"."usage_cpu_second_usd", "workspaces"."usage_memory_gib_second_usd", "workspaces"."usage_credits_per_usd", "workspaces"."usage_finalized_at") = 0) or ("workspaces"."usage_operation_key" is not null and num_nonnulls("workspaces"."usage_last_sample_at", "workspaces"."usage_last_cpu_micros", "workspaces"."usage_cpu_seconds", "workspaces"."usage_memory_gib_seconds", "workspaces"."usage_cpu_second_usd", "workspaces"."usage_memory_gib_second_usd", "workspaces"."usage_credits_per_usd") = 7));
