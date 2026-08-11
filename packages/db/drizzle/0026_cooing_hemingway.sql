CREATE TABLE "credit_exhaustion_episodes" (
	"operation_key" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"exhausted_at" timestamp with time zone NOT NULL,
	"recovered_at" timestamp with time zone,
	"cursor_run_id" text
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "plan_max_credits" numeric(20, 4);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "agent_runs" AS run
		JOIN "organizations" AS organization ON organization."id" = run."organization_id"
		WHERE organization."plan" NOT IN ('trial', 'builder', 'studio')
	) THEN
		RAISE EXCEPTION 'cannot backfill agent_runs.plan_max_credits for an unknown organization plan';
	END IF;
END $$;--> statement-breakpoint
UPDATE "agent_runs" AS run
SET "plan_max_credits" = CASE organization."plan"
	WHEN 'trial' THEN 10.0000
	WHEN 'builder' THEN 100.0000
	WHEN 'studio' THEN 1000.0000
END
FROM "organizations" AS organization
WHERE organization."id" = run."organization_id";--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "plan_max_credits" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_exhaustion_episodes" ADD CONSTRAINT "credit_exhaustion_episodes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_exhaustion_episodes_active_org_idx" ON "credit_exhaustion_episodes" USING btree ("organization_id") WHERE "credit_exhaustion_episodes"."recovered_at" is null;--> statement-breakpoint
CREATE INDEX "credit_exhaustion_episodes_org_time_idx" ON "credit_exhaustion_episodes" USING btree ("organization_id","exhausted_at");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_plan_max_credits_check" CHECK ("agent_runs"."plan_max_credits" >= 1 and "agent_runs"."plan_max_credits" <= 1000000 and trunc("agent_runs"."plan_max_credits") = "agent_runs"."plan_max_credits");
