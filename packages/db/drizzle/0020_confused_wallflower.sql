ALTER TABLE "usage_ledger" ADD COLUMN "operation_key" text;--> statement-breakpoint
ALTER TABLE "usage_ledger" DISABLE TRIGGER "usage_ledger_append_only";--> statement-breakpoint
UPDATE "usage_ledger" SET "operation_key" = "id" WHERE "operation_key" IS NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" ENABLE TRIGGER "usage_ledger_append_only";--> statement-breakpoint
ALTER TABLE "usage_ledger" ALTER COLUMN "operation_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledger_operation_idx" ON "usage_ledger" USING btree ("organization_id","operation_key");
