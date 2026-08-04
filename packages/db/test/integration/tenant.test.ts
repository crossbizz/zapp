import { newId } from '@zapp/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { nextEventSequence } from '../../src/events.js';
import { runEventCounters } from '../../src/schema/execution.js';
import { forOrg } from '../../src/tenant.js';
import { seedTenant, type SeededTenant } from './fixtures.js';
import { hasDatabase, only, setUpTestDatabase, type TestDatabase } from './helpers.js';

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
