CREATE TABLE "activity_idempotency" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"activity_type" text NOT NULL,
	"input_hash" text NOT NULL,
	"status" text NOT NULL,
	"owner_id" text,
	"lease_expires_at" timestamp with time zone,
	"result_hash" text,
	"result_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_idempotency_input_hash_check" CHECK ("activity_idempotency"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "activity_idempotency_result_hash_check" CHECK ("activity_idempotency"."result_hash" is null or "activity_idempotency"."result_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "activity_idempotency_state_check" CHECK ((
        ("activity_idempotency"."status" = 'running' and "activity_idempotency"."owner_id" is not null and "activity_idempotency"."lease_expires_at" is not null and "activity_idempotency"."result_hash" is null and "activity_idempotency"."result_json" is null)
        or
        ("activity_idempotency"."status" = 'completed' and "activity_idempotency"."owner_id" is null and "activity_idempotency"."lease_expires_at" is null and "activity_idempotency"."result_hash" is not null and "activity_idempotency"."result_json" is not null)
      ))
);
--> statement-breakpoint
CREATE INDEX "activity_idempotency_lease_idx" ON "activity_idempotency" USING btree ("status","lease_expires_at");