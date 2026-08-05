import { newId } from '@zapp/contracts';
import { eq } from 'drizzle-orm';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb } from '../../src/client.js';
import { nextEventSequence } from '../../src/events.js';
import { runEventCounters } from '../../src/schema/execution.js';
import { agentRuns } from '../../src/schema/planning.js';
import { branches } from '../../src/schema/projects.js';
import { integrationConnections } from '../../src/schema/security.js';
import { forOrg } from '../../src/tenant.js';
import { seedTenant, type SeededTenant } from './fixtures.js';
import { hasDatabase, only, rejection, setUpTestDatabase, type TestDatabase } from './helpers.js';

/**
 * The isolation proof for plan 01 FND-6, and the contract plan 02 (CP-4) builds
 * its 404 mapping on: another tenant's rows are not forbidden, they are absent.
 */
describe.skipIf(!hasDatabase)('tenant-scoped repositories', () => {
  let handle: TestDatabase;
  let alpha: SeededTenant;
  let beta: SeededTenant;

  beforeAll(async () => {
    handle = await setUpTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await handle.truncateAll();
    alpha = await seedTenant(handle.db, { slug: 'alpha', eventCount: 3 });
    beta = await seedTenant(handle.db, { slug: 'beta', eventCount: 3 });
  });

  describe('projects', () => {
    it('lists only the tenant’s own projects', async () => {
      const projects = await forOrg(handle.db, alpha.organizationId).projects.list();

      expect(projects.map((project) => project.id)).toEqual([alpha.projectId]);
      expect(projects.every((project) => project.organizationId === alpha.organizationId)).toBe(
        true,
      );
    });

    it('returns undefined for another tenant’s project rather than throwing', async () => {
      const scoped = forOrg(handle.db, alpha.organizationId);

      expect(await scoped.projects.getById(beta.projectId)).toBeUndefined();
      // …and the row is genuinely there, so this is scoping and not an empty database.
      expect(
        (await forOrg(handle.db, beta.organizationId).projects.getById(beta.projectId))?.id,
      ).toBe(beta.projectId);
    });

    it('returns undefined for a project id that exists nowhere', async () => {
      expect(
        await forOrg(handle.db, alpha.organizationId).projects.getById(newId('proj')),
      ).toBeUndefined();
    });
  });

  describe('runs', () => {
    it('lists the tenant’s runs for its own project', async () => {
      const runs = await forOrg(handle.db, alpha.organizationId).runs.byProject(alpha.projectId);

      expect(runs.map((run) => run.id)).toEqual([alpha.runId]);
    });

    it('returns nothing for a project belonging to another tenant', async () => {
      const scoped = forOrg(handle.db, alpha.organizationId);

      expect(await scoped.runs.byProject(beta.projectId)).toEqual([]);
      expect(await scoped.runs.getById(beta.runId)).toBeUndefined();
    });
  });

  describe('events', () => {
    it('reads its own run’s events in sequence order', async () => {
      const events = await forOrg(handle.db, alpha.organizationId).events.byRun(alpha.runId);

      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(events.map((event) => event.id)).toEqual(alpha.eventIds);
      expect(events[0]?.payloadJson).toEqual({ tool: 'run_build', exitCode: 0 });
    });

    it('returns [] for another tenant’s run — invisible, not forbidden', async () => {
      // The brief's binding case: beta's run exists, has events, and alpha's
      // handle must simply not see it.
      expect(await forOrg(handle.db, alpha.organizationId).events.byRun(beta.runId)).toEqual([]);
      expect(await forOrg(handle.db, beta.organizationId).events.byRun(beta.runId)).toHaveLength(3);
    });

    it('windows by sequence, as a resumed stream does', async () => {
      const scoped = forOrg(handle.db, alpha.organizationId);

      expect(
        (await scoped.events.byRun(alpha.runId, { fromSequence: 2 })).map((e) => e.sequence),
      ).toEqual([2, 3]);
      expect(
        (await scoped.events.byRun(alpha.runId, { toSequence: 2 })).map((e) => e.sequence),
      ).toEqual([1, 2]);
      expect(
        (await scoped.events.byRun(alpha.runId, { fromSequence: 2, toSequence: 2 })).map(
          (e) => e.sequence,
        ),
      ).toEqual([2]);
      expect((await scoped.events.byRun(alpha.runId, { limit: 1 })).map((e) => e.sequence)).toEqual(
        [1],
      );
    });

    it('does not let a sequence window escape the tenant', async () => {
      // A wide-open window is still scoped: the range arguments must never be
      // the thing that decides which organization's rows come back.
      expect(
        await forOrg(handle.db, alpha.organizationId).events.byRun(beta.runId, {
          fromSequence: 1,
          toSequence: 1_000,
        }),
      ).toEqual([]);
    });

    it('rejects early-aborted reads without consuming database pool slots', async () => {
      // Break caught: postgres.js defers connection assignment by one microtask;
      // cancelling before that assignment can reject the promise yet still
      // enqueue a dead query that permanently owns a pool slot.
      const probe = createDb(handle.url);
      const controller = new AbortController();
      controller.abort();
      try {
        const scoped = forOrg(probe.db, alpha.organizationId);
        const attempts = Array.from({ length: 32 }, async () => {
          await expect(
            scoped.events.byRun(alpha.runId, { signal: controller.signal }),
          ).rejects.toMatchObject({ name: 'AbortError' });
        });
        await Promise.all(attempts);

        const immediateAttempts = Array.from({ length: 32 }, async () => {
          const immediate = new AbortController();
          const read = scoped.events.byRun(alpha.runId, { signal: immediate.signal });
          immediate.abort();
          await expect(read).rejects.toMatchObject({ name: 'AbortError' });
        });
        await Promise.all(immediateAttempts);

        let timeout: NodeJS.Timeout | undefined;
        try {
          const rows = await Promise.race([
            probe.sql<{ ok: number }[]>`select 1::int as ok`,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => {
                reject(new Error('database pool did not recover after pre-aborted reads'));
              }, 1_000);
            }),
          ]);
          expect(rows[0]?.ok).toBe(1);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      } finally {
        await probe.close();
      }
    });

    it('cancels a pool-queued read before a connection is released and recovers full capacity', async () => {
      const probe = createDb(handle.url);
      const scoped = forOrg(probe.db, alpha.organizationId);
      let announceLock!: () => void;
      let releaseLock!: () => void;
      const lockAcquired = new Promise<void>((resolve) => {
        announceLock = resolve;
      });
      const lockReleased = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const lock = handle.sql.begin(async (tx) => {
        await tx.unsafe('lock table agent_events in access exclusive mode');
        announceLock();
        await lockReleased;
      });

      const countQueries = async (marker: string): Promise<number> => {
        const [row] = await handle.sql<{ count: number }[]>`
          select count(*)::int as count
            from pg_stat_activity
           where datname = current_database()
             and pid <> pg_backend_pid()
             and state = 'active'
             and query like ${`%${marker}%`}
        `;
        return row?.count ?? 0;
      };
      const waitForCount = async (marker: string, expected: number): Promise<void> => {
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          if ((await countQueries(marker)) === expected) return;
          await delay(10);
        }
        expect(await countQueries(marker)).toBe(expected);
      };

      let blockers: Promise<unknown>[] = [];
      let queued: Promise<unknown> | undefined;
      try {
        await lockAcquired;
        blockers = Array.from({ length: 10 }, () => scoped.events.byRun(alpha.runId));
        await waitForCount('from agent_events', 10);

        const controller = new AbortController();
        queued = scoped.events.byRun(alpha.runId, { signal: controller.signal });
        controller.abort();
        let timeout: NodeJS.Timeout | undefined;
        try {
          await expect(
            Promise.race([
              queued,
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => {
                  reject(new Error('pool-queued event replay did not cancel before slot release'));
                }, 500);
              }),
            ]),
          ).rejects.toMatchObject({ name: 'AbortError' });
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }

        releaseLock();
        await lock;
        await Promise.all(blockers);

        const reservations: { release(): void }[] = [];
        const acquisitions = Array.from({ length: 10 }, async () => {
          const reservation = await probe.sql.reserve();
          reservations.push(reservation);
          return reservation;
        });
        let recoveryTimeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            Promise.all(acquisitions),
            new Promise<never>((_resolve, reject) => {
              recoveryTimeout = setTimeout(() => {
                reject(new Error('database pool did not recover all ten connection slots'));
              }, 1_000);
            }),
          ]);
          expect(reservations).toHaveLength(10);
        } finally {
          if (recoveryTimeout !== undefined) clearTimeout(recoveryTimeout);
          for (const reservation of reservations.splice(0)) reservation.release();
          await Promise.allSettled(acquisitions);
          for (const reservation of reservations.splice(0)) reservation.release();
        }
      } finally {
        releaseLock();
        await lock;
        await Promise.allSettled(blockers);
        await queued?.catch(() => undefined);
        await probe.close();
      }
    });
  });

  describe('composite tenant keys', () => {
    it('refuses a child row whose tenant does not match the project it names', async () => {
      // The isolation hole this closes: alpha's organization id on beta's
      // project would make the row visible to alpha through every forOrg query.
      // The denormalized column is now checked against its parent, so the write
      // fails instead of the read leaking.
      const error = await rejection(
        handle.db.insert(agentRuns).values({
          id: newId('run'),
          organizationId: alpha.organizationId,
          projectId: beta.projectId,
          mode: 'build',
          status: 'running',
          startedBy: alpha.userId,
        }),
      );

      expect(error).toMatchObject({
        code: '23503', // foreign_key_violation
        constraint_name: 'agent_runs_project_tenant_fk',
      });
    });

    it('refuses the same mismatch on a branch, and accepts the matching pair', async () => {
      expect(
        await rejection(
          handle.db.insert(branches).values({
            id: newId('br'),
            organizationId: alpha.organizationId,
            projectId: beta.projectId,
            name: 'smuggled',
            status: 'active',
          }),
        ),
      ).toMatchObject({ code: '23503', constraint_name: 'branches_project_tenant_fk' });

      const id = newId('br');
      await handle.db.insert(branches).values({
        id,
        organizationId: beta.organizationId,
        projectId: beta.projectId,
        name: 'legitimate',
        status: 'active',
      });
      expect(only(await handle.db.select().from(branches).where(eq(branches.id, id))).name).toBe(
        'legitimate',
      );
    });

    it('still allows an organization-level row with no project', async () => {
      // MATCH SIMPLE skips the check when project_id is null, which is what
      // keeps org-wide secrets and GitHub App installations legal.
      const id = newId('intc');
      await handle.db.insert(integrationConnections).values({
        id,
        organizationId: alpha.organizationId,
        provider: 'github',
        status: 'active',
        configurationJson: { installationId: 42 },
      });

      const row = only(
        await handle.db
          .select()
          .from(integrationConnections)
          .where(eq(integrationConnections.id, id)),
      );
      expect(row.projectId).toBeNull();
    });
  });

  describe('forOrg', () => {
    it('rejects an id that is not an organization id', () => {
      expect(() => forOrg(handle.db, alpha.projectId)).toThrow(/Invalid org id/);
      expect(() => forOrg(handle.db, '')).toThrow(/Invalid org id/);
    });
  });

  describe('nextEventSequence', () => {
    it('hands out 1…100 exactly once each under 100 concurrent callers', async () => {
      // The property that matters: no gaps (a consumer would read that as a
      // dropped event) and no duplicates (two events would claim one slot).
      const sequences = await Promise.all(
        Array.from({ length: 100 }, () => nextEventSequence(handle.db, beta.runId)),
      );

      // beta was seeded with 3 events, so the allocator continues from 3.
      const expected = Array.from({ length: 100 }, (_, index) => index + 4);
      expect([...sequences].sort((a, b) => a - b)).toEqual(expected);
      expect(new Set(sequences).size).toBe(sequences.length);

      const counter = only(
        await handle.db
          .select()
          .from(runEventCounters)
          .where(eq(runEventCounters.runId, beta.runId)),
      );
      expect(counter.lastSequence).toBe(103);
    });

    it('starts a run that has never emitted an event at 1', async () => {
      const fresh = await seedTenant(handle.db, { slug: 'gamma' });

      expect(await nextEventSequence(handle.db, fresh.runId)).toBe(1);
      expect(await nextEventSequence(handle.db, fresh.runId)).toBe(2);
    });

    it('gives up its allocation when the transaction rolls back', async () => {
      // Allocating inside the transaction that writes the event is what keeps
      // the numbering gapless: a rolled-back write must not consume a number.
      await expect(
        handle.db.transaction(async (tx) => {
          expect(await nextEventSequence(tx, alpha.runId)).toBe(4);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      expect(await nextEventSequence(handle.db, alpha.runId)).toBe(4);
    });
  });
});
