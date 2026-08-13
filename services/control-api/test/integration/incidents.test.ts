import { newId } from '@zapp/contracts';
import { auditEvents, organizations } from '@zapp/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbIncidentStore } from '../../src/incidents/store.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';
import { TEST_MASTER_KEY } from '../support/harness.js';

describe.skipIf(!hasDatabase)('the incident ledger, on PostgreSQL', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await setUpTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.truncateIdentity();
  });

  it('persists one idempotent incident and its transactional Fix and release links', async () => {
    const organizationId = newId('org');
    const projectId = newId('proj');
    const releaseId = newId('rel');
    const userId = newId('user');
    await database.db.insert(organizations).values({
      id: organizationId,
      name: 'Incident Ledger',
      slug: `incident-${organizationId.slice(-8).toLowerCase()}`,
    });
    const store = createDbIncidentStore(database.db, TEST_MASTER_KEY);
    const diagnosticSecret = 'incident-diagnostic-must-be-encrypted';
    const input = {
      idempotencyKey: 'grafana:release:checkout-timeout',
      organizationId,
      projectId,
      releaseId,
      commitSha: 'a'.repeat(40),
      source: 'grafana_faro' as const,
      title: 'Checkout timeout',
      errorPayload: `POST /checkout returned 504: ${diagnosticSecret}`,
      traceUrl: 'https://grafana.example.test/explore?trace=checkout',
      logsUrl: null,
      reproductionRoute: '/checkout',
      evidenceArtifactId: null,
      actorType: 'service' as const,
      actorId: 'grafana-alerting',
      createdAt: new Date('2026-08-12T12:00:00.000Z'),
    };

    const [first, replay] = await Promise.all([store.create(input), store.create(input)]);
    expect(replay.id).toBe(first.id);
    expect(
      await database.db
        .select({ id: auditEvents.id, metadataJson: auditEvents.metadataJson })
        .from(auditEvents)
        .where(eq(auditEvents.action, 'incident.created')),
    ).toHaveLength(1);
    const [creation] = await database.db
      .select({ metadataJson: auditEvents.metadataJson })
      .from(auditEvents)
      .where(eq(auditEvents.action, 'incident.created'));
    expect(JSON.stringify(creation?.metadataJson)).not.toContain(diagnosticSecret);

    const runId = newId('run');
    await database.db.transaction(async (tx) => {
      await store.linkFixRun(tx, {
        organizationId,
        projectId,
        incidentId: first.id,
        releaseId,
        runId,
        actorId: userId,
        occurredAt: new Date('2026-08-12T12:01:00.000Z'),
      });
    });
    const resolutionReleaseId = newId('rel');
    await database.db.transaction(async (tx) => {
      await store.resolveForRun(tx, {
        organizationId,
        projectId,
        fixRunId: runId,
        releaseId: resolutionReleaseId,
        actorId: userId,
        occurredAt: new Date('2026-08-12T12:02:00.000Z'),
      });
    });

    const reloaded = createDbIncidentStore(database.db, TEST_MASTER_KEY);
    const page = await reloaded.list({ organizationId, projectId, limit: 50 });
    expect(page).toEqual({
      items: [
        expect.objectContaining({
          id: first.id,
          errorPayload: input.errorPayload,
          fixRunId: runId,
          resolutionReleaseId,
        }),
      ],
      nextCursor: null,
    });
    expect(
      (await reloaded.list({ organizationId: newId('org'), projectId, limit: 50 })).items,
    ).toEqual([]);

    const otherOrganizationId = newId('org');
    await database.db.insert(organizations).values({
      id: otherOrganizationId,
      name: 'Other Incident Ledger',
      slug: `incident-${otherOrganizationId.slice(-8).toLowerCase()}`,
    });
    const other = await store.create({
      ...input,
      organizationId: otherOrganizationId,
      projectId: newId('proj'),
      releaseId: newId('rel'),
    });
    expect(other.id).not.toBe(first.id);
  });
});
