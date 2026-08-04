-- Append-only ledgers: `usage_ledger` and `audit_events` (plan 02 CP-2, deferred
-- from the CP-1 review; PRD §23.1, §23.6).
--
-- Both tables are evidence. Usage is what a customer is billed from and what a
-- refund is argued with; audit events are what an incident is reconstructed
-- from. A row that can be edited after the fact is worth less than no row at
-- all, so neither table accepts UPDATE or DELETE.
--
-- Two mechanisms, because either alone is a half-measure:
--
--   1. REVOKE UPDATE, DELETE from the application role — the control the review
--      asked for, and the one that matters in staging and production, where
--      migrations run as an owner/migrator role and the API connects as an
--      unprivileged `zapp` role.
--   2. A BEFORE UPDATE OR DELETE trigger — because privileges alone cannot
--      enforce this in development or CI, where the role in DATABASE_URL is the
--      table owner *and* a superuser (docker-compose's POSTGRES_USER, the CI
--      service container's `postgres`). An owner can re-grant to itself and a
--      superuser bypasses privilege checks outright, so the REVOKE is a no-op
--      there. The trigger holds for every role, which makes the property true
--      in every environment instead of only in production.
--
-- Both halves are guarded: the `zapp` role and the FND-6 tables are each
-- optional in any given database, and a migration that assumed either would
-- break a developer's partially-migrated stack.
--
-- Deliberate maintenance (a retention purge, a GDPR erasure) is an owner
-- running `ALTER TABLE ... DISABLE TRIGGER` inside a transaction — which is
-- about the right amount of friction for editing a ledger.
CREATE OR REPLACE FUNCTION zapp_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	-- 42501 is insufficient_privilege: the same class a REVOKE produces, so a
	-- caller sees one failure mode whichever mechanism stopped it.
	RAISE EXCEPTION USING
		ERRCODE = '42501',
		MESSAGE = format('%s is append-only', TG_TABLE_NAME),
		DETAIL = format('%s is not permitted on this table', TG_OP);
END;
$$;
--> statement-breakpoint
DO $$
DECLARE
	target text;
	trigger_name text;
BEGIN
	FOREACH target IN ARRAY ARRAY['usage_ledger', 'audit_events'] LOOP
		IF to_regclass(format('public.%I', target)) IS NULL THEN
			-- The table lands with FND-6; this migration is allowed to run first.
			RAISE NOTICE 'zapp_append_only: skipping %, table does not exist', target;
			CONTINUE;
		END IF;

		trigger_name := format('%s_append_only', target);
		EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', trigger_name, target);
		-- FOR EACH STATEMENT, not FOR EACH ROW: a row-level trigger fires once per
		-- affected row, so `UPDATE usage_ledger SET ...` against rows that do not
		-- match would quietly succeed. Blocking the statement blocks the intent,
		-- and costs one function call instead of one per row.
		EXECUTE format(
			'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION zapp_append_only()',
			trigger_name,
			target
		);

		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zapp') THEN
			EXECUTE format('REVOKE UPDATE, DELETE ON public.%I FROM zapp', target);
		END IF;
	END LOOP;
END;
$$;
