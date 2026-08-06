ALTER TABLE "agent_runs" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
UPDATE "agent_runs" SET "request_fingerprint" = 'legacy:' || "id";--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "request_fingerprint" SET NOT NULL;
