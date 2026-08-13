ALTER TABLE "sandbox_snapshot_measurements" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "sandbox_snapshot_measurements" ADD COLUMN "created_at" timestamp with time zone;--> statement-breakpoint
UPDATE "sandbox_snapshot_measurements"
SET "kind" = CASE
      WHEN "expires_at" <= "measured_at" + interval '7 days 1 minute' THEN 'diagnostic'
      ELSE 'active'
    END,
    "created_at" = CASE
      WHEN "expires_at" <= "measured_at" + interval '7 days 1 minute' THEN "expires_at" - interval '7 days'
      ELSE "expires_at" - interval '30 days'
    END;--> statement-breakpoint
ALTER TABLE "sandbox_snapshot_measurements" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_snapshot_measurements" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_snapshot_measurements" ADD CONSTRAINT "sandbox_snapshot_measurements_kind_check" CHECK (kind in ('active', 'diagnostic', 'release_evidence'));
