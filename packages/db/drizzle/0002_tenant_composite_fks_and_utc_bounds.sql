-- ---------------------------------------------------------------------------
-- Composite tenant foreign keys (FND-6 review, important 2)
--
-- `organization_id` is denormalized onto every tenant-owned table so that
-- `forOrg` can filter directly (PRD §22.3). Until now nothing checked the copy:
-- a writer that paired org A with a project belonging to org B produced a row
-- that org A's queries would happily return. That is an isolation hole one bug
-- wide, and it was only ever caught by review.
--
-- Each project-owned table now also carries
--   (project_id, organization_id) -> projects (id, organization_id),
-- so the mismatch is a foreign-key violation at insert time. The unique index
-- comes first because a composite foreign key needs one on exactly the columns
-- it targets. MATCH SIMPLE (the default) skips the check when project_id is
-- null, which keeps organization-level rows legal in secret_metadata and
-- integration_connections.
--
-- Covered, one per table that carries both columns: agent_runs, artifacts,
-- branches, decisions, environments, integration_connections, project_contracts,
-- releases, repositories, secret_metadata, specifications, synthetic_checks,
-- workspaces.
--
-- Not covered, because they carry no project_id: agent_phases, agent_tasks,
-- approvals, agent_events, test_runs, test_cases, verification_results,
-- deployments. Their tenant column is still unchecked against their own parent
-- (run, phase, test run, release). Closing that needs the same pattern one
-- level down — a unique (id, organization_id) on each of those parents — and is
-- left to whoever owns the write paths (plan 02 CP-13, plan 05); see the FND-6
-- report. Additive either way: nothing here has to be undone to do it.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "projects_id_org_idx" ON "projects" USING btree ("id","organization_id");
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_contracts" ADD CONSTRAINT "project_contracts_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "secret_metadata" ADD CONSTRAINT "secret_metadata_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "synthetic_checks" ADD CONSTRAINT "synthetic_checks_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_project_tenant_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- UTC partition bounds (FND-6 review, minor 4)
--
-- Replaces both partition functions with the versions in 0001, which pin month
-- edges to UTC instants instead of letting the session's TimeZone GUC decide.
-- 0001 carries the same text: a database created from scratch gets it there,
-- and this statement is what converges one that applied the earlier version.
-- Bodies are byte-identical to 0001's on purpose — one source, copied, not two
-- that can drift.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_event_partition(starts date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
	partition_name text := format('agent_events_%s', to_char(starts, 'YYYY_MM'));
	-- Month edges are UTC instants whatever the server's TimeZone GUC says. A bare
	-- date in the bound would be cast to timestamptz using the session zone, so a
	-- database migrated under America/New_York would cut its months at 04:00 UTC
	-- and file the first four hours of each month in the previous partition.
	starts_at timestamptz := starts::timestamp AT TIME ZONE 'UTC';
	ends_at timestamptz := (starts + interval '1 month')::timestamp AT TIME ZONE 'UTC';
BEGIN
	EXECUTE format(
		'CREATE TABLE IF NOT EXISTS %I PARTITION OF agent_events FOR VALUES FROM (%L) TO (%L)',
		partition_name, starts_at, ends_at
	);
	-- Unique per partition, not globally: Postgres requires the partition key
	-- in every unique index on a partitioned table, and (run_id, sequence,
	-- occurred_at) would not be the constraint the event contract needs.
	-- Global uniqueness comes from run_event_counters being the single
	-- allocator of sequence numbers (nextEventSequence); this index is what
	-- catches a replayed insert inside the month it belongs to.
	EXECUTE format(
		'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (run_id, sequence)',
		partition_name || '_run_sequence_idx', partition_name
	);
	RETURN partition_name;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_next_partition() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
	latest date;
BEGIN
	-- The newest existing month, read from the partition names rather than from
	-- their bounds: pg_get_expr(relpartbound) would have to be parsed back.
	SELECT max(to_date(substring(child.relname FROM '\d{4}_\d{2}$'), 'YYYY_MM'))
		INTO latest
		FROM pg_inherits
		JOIN pg_class child ON child.oid = pg_inherits.inhrelid
		JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
		WHERE parent.relname = 'agent_events';

	RETURN create_event_partition(
		(coalesce(latest, date_trunc('month', now())::date) + interval '1 month')::date
	);
END;
$$;