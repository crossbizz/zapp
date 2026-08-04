-- Closes the last way to empty an append-only ledger: `TRUNCATE` (plan 02 CP-2
-- follow-up, routed to FND-6 as the owner of the test harness that blocked it).
--
-- `0004` revoked TRUNCATE from the application role but deliberately stopped
-- short of a trigger, because a `BEFORE TRUNCATE` trigger stops the owner and
-- the superuser too — and that broke `packages/db/test/integration/helpers.ts`,
-- which resets the shared test database between tests. That was a real
-- constraint, not an excuse; it has now been fixed on the harness side, which
-- stands the guards down inside a transaction and puts them back, using the
-- escape hatch `0003` documents for deliberate maintenance.
--
-- Why the REVOKE alone was not enough. It binds only where the API connects as
-- a role that owns nothing — staging and production. In development and CI the
-- role in DATABASE_URL owns the tables and is usually a superuser, so the
-- REVOKE is a no-op there and a stray `TRUNCATE usage_ledger` succeeds in
-- silence. That is precisely where a careless statement gets written, and where
-- a developer learns whether the rule is real. The trigger makes the property
-- true in every environment, which is the same argument `0003` made for UPDATE
-- and DELETE.
--
-- A separate trigger from `<table>_append_only`, because Postgres will not let
-- one trigger cover TRUNCATE and row-level events together. The name extends
-- the same convention, and deliberately does not *end* in `_append_only`: the
-- CP-2 suite asserts the exact set of triggers matching `%_append_only`, and a
-- second one per table would have broken an assertion that is still correct.
--
-- Replay-safe (DROP IF EXISTS then CREATE) and guarded the way `0004` is: a
-- missing table fails the migration rather than being skipped in silence. The
-- function is `0003`'s, unchanged — it reports `TG_OP`, so the error already
-- says TRUNCATE without a word of new code.
DO $$
DECLARE
	target text;
	trigger_name text;
BEGIN
	FOREACH target IN ARRAY ARRAY['usage_ledger', 'audit_events'] LOOP
		IF to_regclass(format('public.%I', target)) IS NULL THEN
			RAISE EXCEPTION 'append-only migration: table public.% does not exist', target;
		END IF;

		trigger_name := format('%s_append_only_truncate', target);
		EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', trigger_name, target);
		EXECUTE format(
			'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION zapp_append_only()',
			trigger_name,
			target
		);
		RAISE NOTICE 'append-only: TRUNCATE on % now refused for every role', target;
	END LOOP;
END;
$$;
