DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "approvals"
     WHERE "type" = 'budget_increase'
       AND jsonb_typeof("request_json") IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION 'cannot backfill a non-object budget_increase approval request_json';
  END IF;
END $$;
--> statement-breakpoint
UPDATE "approvals"
   SET "request_json" = jsonb_set(
     "request_json",
     '{reason}',
     '"run_budget_exhausted"'::jsonb,
     true
   )
 WHERE "type" = 'budget_increase'
   AND NOT ("request_json" ? 'reason');
