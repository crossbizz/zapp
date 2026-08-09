-- Extends the application-role append-only grant boundary to the approval-backed
-- run credit ceiling adjustment ledger introduced by 0014. The original 0014
-- migration could only revoke privileges from the conventional `zapp` role;
-- deployments may instead configure the application role through
-- `zapp.app_role`, as established by 0004.
DO $$
DECLARE
	app_role text := coalesce(nullif(current_setting('zapp.app_role', true), ''), current_user);
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
		RAISE EXCEPTION 'append-only migration: role % does not exist', app_role
			USING HINT = 'Set zapp.app_role to the role the API connects as.';
	END IF;

	IF to_regclass('public.run_credit_ceiling_adjustments') IS NULL THEN
		RAISE EXCEPTION 'append-only migration: table public.run_credit_ceiling_adjustments does not exist';
	END IF;

	EXECUTE format(
		'REVOKE UPDATE, DELETE, TRUNCATE ON public.run_credit_ceiling_adjustments FROM %I',
		app_role
	);
END;
$$;
