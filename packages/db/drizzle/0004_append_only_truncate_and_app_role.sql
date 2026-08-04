-- Completes the append-only guarantee on `usage_ledger` and `audit_events`
-- (plan 02 CP-2 review, fix round 1). Extends `0003` rather than editing it:
-- `0003` is already committed and applied to other developers' databases, and a
-- migration that has run somewhere is history, not a draft.
--
-- Three changes:
--
--   1. TRUNCATE joins UPDATE and DELETE in the REVOKE. It was the hole in
--      `0003`: TRUNCATE fires no row triggers, needs no WHERE clause, and
--      empties a ledger in one statement — the most efficient way to destroy
--      exactly the evidence these tables exist to keep.
--   2. The revoke target is no longer the hardcoded `zapp`. It is
--      `zapp.app_role` when the migration runs with one set
--      (`PGOPTIONS='-c zapp.app_role=…'`, or `ALTER DATABASE … SET`), and
--      `current_user` otherwise — which is the application role in development,
--      where the connection string's role is the only role there is. A named
--      role that does not exist now fails the migration instead of being
--      skipped in silence.
--   3. Missing tables fail the migration too. `0003` tolerated them because
--      FND-6's tables were still in flight; they have landed, so a database
--      without them is a broken database, not an early one.
--
-- TRUNCATE is covered by the REVOKE alone, deliberately, and not by the trigger.
-- A `BEFORE TRUNCATE` trigger would also stop the owner and the superuser — but
-- it would stop `packages/db/test/integration/helpers.ts` too, which resets the
-- shared test database by truncating every table in `public` between tests, and
-- FND-6's billing suite writes `usage_ledger` rows. Adding one breaks four of
-- their tests (measured, not guessed). The privilege is where the protection
-- belongs anyway: in staging and production the API connects as a role that
-- owns nothing, so REVOKE is binding for it, and any role that could truncate
-- past the REVOKE (owner, superuser) could equally well have dropped the
-- trigger. What the trigger buys — protection from an owner's own mistake — is
-- kept for UPDATE and DELETE, which is where a careless statement is far likelier.
--
-- The escape hatch for deliberate maintenance is still `ALTER TABLE … DISABLE
-- TRIGGER`, which requires table ownership. A session GUC would have been
-- friendlier and worthless: setting one needs no privilege, so a compromised
-- application role could turn the guard off by itself.
CREATE OR REPLACE FUNCTION zapp_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	-- 42501 is insufficient_privilege: the same class a REVOKE produces, so a
	-- caller sees one failure mode whichever mechanism stopped it.
	RAISE EXCEPTION USING
		ERRCODE = '42501',
		MESSAGE = format('%s is append-only', TG_TABLE_NAME),
		DETAIL = format('%s is not permitted on this table', TG_OP),
		HINT = 'A deliberate correction is a compensating entry; deliberate maintenance is ALTER TABLE ... DISABLE TRIGGER inside a transaction.';
END;
$$;
--> statement-breakpoint
DO $$
DECLARE
	target text;
	trigger_name text;
	app_role text := coalesce(nullif(current_setting('zapp.app_role', true), ''), current_user);
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
		RAISE EXCEPTION 'append-only migration: role % does not exist', app_role
			USING HINT = 'Set zapp.app_role to the role the API connects as.';
	END IF;

	FOREACH target IN ARRAY ARRAY['usage_ledger', 'audit_events'] LOOP
		IF to_regclass(format('public.%I', target)) IS NULL THEN
			RAISE EXCEPTION 'append-only migration: table public.% does not exist', target;
		END IF;

		trigger_name := format('%s_append_only', target);
		EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', trigger_name, target);
		-- FOR EACH STATEMENT, not FOR EACH ROW: a row-level trigger fires once per
		-- affected row, so `UPDATE usage_ledger SET ...` matching nothing would
		-- quietly succeed. Recreated here rather than left to `0003` because that
		-- migration's first form was row-level, and a database migrated while it
		-- was still in flight would otherwise keep it.
		EXECUTE format(
			'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION zapp_append_only()',
			trigger_name,
			target
		);

		-- Correct and sufficient wherever the API connects as a role that owns
		-- nothing; a no-op where that role is the owner or a superuser, which is
		-- why the trigger above exists as well.
		EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM %I', target, app_role);
		RAISE NOTICE 'append-only: % protected, UPDATE/DELETE/TRUNCATE revoked from %', target, app_role;
	END LOOP;
END;
$$;
