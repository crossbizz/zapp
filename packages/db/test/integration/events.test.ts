import { newId } from '@zapp/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { agentEvents, MAX_EVENT_PAYLOAD_BYTES } from '../../src/schema/execution.js';
import { EVENT_TIME, seedTenant, type SeededTenant } from './fixtures.js';
import { hasDatabase, only, rejection, setUpTestDatabase, type TestDatabase } from './helpers.js';

/**
 * A partition bound, compared as an instant.
 *
 * `pg_get_expr` renders the bound literal in the *reading* session's time zone,
 * so string-matching it would test the reader's TimeZone rather than the bound.
 * The comparison therefore happens in SQL, against an explicit UTC instant, and
 * only a boolean comes back.
 */
const boundIsUtc = (edge: 'FROM' | 'TO', instant: string): string =>
  String.raw`(regexp_match(pg_get_expr(relpartbound, oid), $re$${edge} \('([^']+)'\)$re$))[1]::timestamptz = timestamptz '${instant}'`;

/**
 * `agent_events` is the one physically unusual table in the schema: a
 * range-partitioned parent whose DDL is hand-written (plan 01 FND-6). These
 * tests are what keep the hand-written half honest.
 */
describe.skipIf(!hasDatabase)('agent_events', () => {
  let handle: TestDatabase;
  let tenant: SeededTenant;

  beforeAll(async () => {
    handle = await setUpTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await handle.truncateAll();
    tenant = await seedTenant(handle.db, { slug: 'alpha', eventCount: 1 });
  });

  describe('partitioning', () => {
    it('is a partitioned parent with twelve monthly partitions from 2026-08', async () => {
      const partitions = await handle.sql<{ name: string }[]>`
        select child.relname as name
          from pg_inherits
          join pg_class child on child.oid = pg_inherits.inhrelid
          join pg_class parent on parent.oid = pg_inherits.inhparent
         where parent.relname = 'agent_events'
         order by child.relname
      `;

      expect(partitions.map((partition) => partition.name)).toEqual([
        'agent_events_2026_08',
        'agent_events_2026_09',
        'agent_events_2026_10',
        'agent_events_2026_11',
        'agent_events_2026_12',
        'agent_events_2027_01',
        'agent_events_2027_02',
        'agent_events_2027_03',
        'agent_events_2027_04',
        'agent_events_2027_05',
        'agent_events_2027_06',
        'agent_events_2027_07',
      ]);
    });

    it('routes a row to the partition its occurred_at falls in', async () => {
      const [row] = await handle.sql<{ partition: string }[]>`
        select tableoid::regclass::text as partition from agent_events
      `;
      expect(row?.partition).toBe('agent_events_2026_08');
    });

    it('refuses a row no partition covers, loudly', async () => {
      // The deliberate design: there is no DEFAULT partition, because a row
      // hiding in one would outlive its retention window and stay invisible to
      // the month-at-a-time archiver (plan 10 OPS-14).
      const error = await rejection(
        handle.db.insert(agentEvents).values({
          id: newId('evt'),
          organizationId: tenant.organizationId,
          runId: tenant.runId,
          projectId: tenant.projectId,
          sequence: 99,
          type: 'run.created',
          payloadJson: {},
          visibility: 'user',
          occurredAt: new Date('2099-01-01T00:00:00.000Z'),
        }),
      );

      expect(error).toMatchObject({ code: '23514' });
      expect(String((error as { message?: string }).message)).toContain('no partition of relation');
    });

    it('cuts months at UTC instants, not at the session zone’s midnight', async () => {
      // `unsafe` because these are SQL fragments, not values: the driver would
      // otherwise bind the expression itself as a parameter. Nothing here comes
      // from outside this file.
      const bounds = await handle.sql.unsafe<{ lower: boolean; upper: boolean }[]>(
        `select ${boundIsUtc('FROM', '2026-08-01 00:00:00+00')} as lower,
                ${boundIsUtc('TO', '2026-09-01 00:00:00+00')} as upper
           from pg_class where relname = 'agent_events_2026_08'`,
      );

      expect(only(bounds).lower).toBe(true);
      expect(only(bounds).upper).toBe(true);
    });

    it('creates UTC-edged partitions even from a New York session', async () => {
      // A bare date in the DDL is cast to timestamptz with the session's zone,
      // so before the fix this partition would have started at 05:00 UTC and
      // swallowed the first five hours of March into February (minor 4).
      await expect(
        handle.db.transaction(async (tx) => {
          // SET LOCAL: the setting dies with the transaction, along with the
          // partition this creates.
          await tx.execute(sql`set local timezone = 'America/New_York'`);
          await tx.execute(sql`select create_event_partition('2028-03-01')`);

          const bounds = await tx.execute<{ lower: boolean }>(
            sql`select ${sql.raw(boundIsUtc('FROM', '2028-03-01 00:00:00+00'))} as lower
                  from pg_class where relname = 'agent_events_2028_03'`,
          );
          expect(bounds[0]?.lower).toBe(true);

          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
    });

    it('create_next_partition() extends the runway with its unique index', async () => {
      // Inside a transaction that rolls back: DDL is transactional in Postgres,
      // so this proves the function without leaving a partition behind.
      await expect(
        handle.db.transaction(async (tx) => {
          const created = await tx.execute<{ create_next_partition: string }>(
            sql`select create_next_partition()`,
          );
          expect(created[0]?.create_next_partition).toBe('agent_events_2027_08');

          const indexes = await tx.execute<{ indexname: string }>(
            sql`select indexname from pg_indexes where tablename = 'agent_events_2027_08' order by indexname`,
          );
          expect(indexes.map((index) => index.indexname)).toContain(
            'agent_events_2027_08_run_sequence_idx',
          );

          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      const after = await handle.sql<{ count: string }[]>`
        select count(*)::text as count from pg_class where relname = 'agent_events_2027_08'
      `;
      expect(only(after).count).toBe('0');
    });
  });

  describe('constraints', () => {
    it('rejects a second event claiming a sequence the run already used', async () => {
      const error = await rejection(
        handle.db.insert(agentEvents).values({
          id: newId('evt'),
          organizationId: tenant.organizationId,
          runId: tenant.runId,
          projectId: tenant.projectId,
          sequence: 1, // seedTenant already wrote sequence 1
          type: 'run.started',
          payloadJson: {},
          visibility: 'user',
          occurredAt: EVENT_TIME,
        }),
      );

      expect(error).toMatchObject({
        code: '23505', // unique_violation
        constraint_name: 'agent_events_2026_08_run_sequence_idx',
      });
    });

    it('rejects a payload larger than 64 KiB', async () => {
      // Larger blobs belong in `artifacts` + object storage (master plan §5.2);
      // the ceiling is enforced here so an oversized event is never written at
      // all, rather than discovered when the stream stalls.
      const error = await rejection(
        handle.db.insert(agentEvents).values({
          id: newId('evt'),
          organizationId: tenant.organizationId,
          runId: tenant.runId,
          projectId: tenant.projectId,
          sequence: 2,
          type: 'tool.output',
          payloadJson: { blob: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES + 1_000) },
          visibility: 'internal',
          occurredAt: EVENT_TIME,
        }),
      );

      expect(error).toMatchObject({
        code: '23514', // check_violation
        constraint_name: 'agent_events_payload_size_check',
      });
    });

    it('accepts a payload just under the ceiling', async () => {
      await handle.db.insert(agentEvents).values({
        id: newId('evt'),
          organizationId: tenant.organizationId,
          runId: tenant.runId,
          projectId: tenant.projectId,
        sequence: 2,
        type: 'tool.output',
        payloadJson: { blob: 'x'.repeat(60_000) },
        visibility: 'internal',
        occurredAt: EVENT_TIME,
      });

      const [row] = await handle.sql<{ count: string }[]>`
        select count(*)::text as count from agent_events where run_id = ${tenant.runId}
      `;
      expect(row?.count).toBe('2');
    });

    it('rejects a visibility outside the PRD §14.4 set', async () => {
      // Raw SQL on purpose: the TypeScript enum makes this unrepresentable
      // through Drizzle, so only the database CHECK can be exercised here.
      //
      // The timestamp goes over as an ISO string rather than as a Date:
      // postgres.js infers a parameter's type with `instanceof Date`, and a
      // Date built in a Vitest module is not an instance of the `Date` the
      // natively-imported driver sees. Drizzle never hits this because it maps
      // its own values; raw queries here must.
      const error = await rejection(handle.sql`
        insert into agent_events
          (id, organization_id, run_id, project_id, sequence, type, payload_json, visibility, occurred_at)
        values
          (${newId('evt')}, ${tenant.organizationId}, ${tenant.runId}, ${tenant.projectId}, 2, 'run.started',
           '{}'::jsonb, 'public', ${EVENT_TIME.toISOString()})
      `);

      expect(error).toMatchObject({
        code: '23514',
        constraint_name: 'agent_events_visibility_check',
      });
    });

    it('rejects an event pointing at a run that does not exist', async () => {
      const error = await rejection(
        handle.db.insert(agentEvents).values({
          id: newId('evt'),
          organizationId: tenant.organizationId,
          runId: newId('run'),
          projectId: tenant.projectId,
          sequence: 1,
          type: 'run.created',
          payloadJson: {},
          visibility: 'user',
          occurredAt: EVENT_TIME,
        }),
      );

      expect(error).toMatchObject({
        code: '23503', // foreign_key_violation
        constraint_name: 'agent_events_run_id_agent_runs_id_fk',
      });
    });
  });

  it('round-trips the row Mission Control replays', async () => {
    const [row] = await handle.db.select().from(agentEvents);

    expect(row?.id).toBe(tenant.eventIds[0]);
    // bigint comes back as a JS number, not a string: `sequence` is compared and
    // incremented by callers, and a string would compare lexicographically.
    expect(row?.sequence).toBe(1);
    expect(row?.occurredAt).toEqual(EVENT_TIME);
    expect(row?.payloadJson).toEqual({
      tool: 'run_build',
      exitCode: 0,
      userSummary: 'Ran the build',
    });
    expect(row?.visibility).toBe('user');
  });
});
