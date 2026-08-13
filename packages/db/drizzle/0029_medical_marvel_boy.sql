CREATE TABLE "trial_credit_grants" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "trial_credit_grants_state_check" CHECK (state in ('pending', 'delivered'))
);
--> statement-breakpoint
ALTER TABLE "trial_credit_grants" ADD CONSTRAINT "trial_credit_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_credit_grants" ADD CONSTRAINT "trial_credit_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trial_credit_grants_user_idx" ON "trial_credit_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trial_credit_grants_pending_idx" ON "trial_credit_grants" USING btree ("state","created_at");