CREATE TABLE "github_webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event_name" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "github_webhook_deliveries_status_check" CHECK ("github_webhook_deliveries"."status" in ('pending', 'published'))
);
--> statement-breakpoint
CREATE INDEX "github_webhook_deliveries_pending_idx" ON "github_webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_github_installation_idx" ON "integration_connections" USING btree ("organization_id","provider",("configuration_json" ->> 'installationId')) WHERE "integration_connections"."provider" = 'github' and "integration_connections"."project_id" is null;