import { newId } from '@zapp/contracts';
import { usageLedger, usageOutbox } from '@zapp/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createDbUsageStore,
  createUsageService,
  UsageEntrySchema,
  UsageIdentityConflictError,
} from '../../src/usage/ledger.js';
import { FlexpriceUsageEventSchema } from '../../src/usage/flexprice.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

describe.skipIf(!hasDatabase)('OPS-1B transactional usage persistence', () => {
  let database: TestDatabase;
  let organizationId = '';

  beforeAll(async () => {
    database = await setUpTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.truncateIdentity();
    organizationId = newId('org');
    await database.sql`
      insert into organizations (id, name, slug)
      values (${organizationId}, 'Usage', ${organizationId})
    `;
  });

  it('commits one ledger row and one outbox event across retries and compensations', async () => {
    const service = createUsageService({ store: createDbUsageStore(database.db) });
    const debit = UsageEntrySchema.parse({
      id: `usage_${'a'.repeat(64)}_sandbox_cpu_seconds`,
      organizationId,
      projectId: null,
      runId: null,
      taskId: null,
      category: 'sandbox_cpu_seconds',
      provider: 'modal',
      quantity: '60.000000',
      unit: 'cpu_second',
      costUsd: '0.120000',
      creditsCharged: '12.0000',
      occurredAt: '2026-08-11T12:00:00.000Z',
    });
    const correction = UsageEntrySchema.parse({
      ...debit,
      id: `usage_${'c'.repeat(64)}_sandbox_cpu_seconds`,
      quantity: '-60.000000',
      costUsd: '-0.120000',
      creditsCharged: '-12.0000',
      correctionOf: debit.id,
    });

    await service.recordUsage(debit);
    await service.recordUsage(debit);
    await service.recordUsage(correction);

    const rows = await database.db
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.organizationId, organizationId));
    const outbox = await database.db
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.organizationId, organizationId));
    expect(rows).toHaveLength(2);
    expect(outbox).toHaveLength(2);
    const events = outbox.map((row) => FlexpriceUsageEventSchema.parse(row.eventJson));
    expect(events.map((event) => event.event_id)).toEqual(
      expect.arrayContaining([debit.id, correction.id]),
    );
    expect(events.find((event) => event.event_id === correction.id)?.properties).toMatchObject({
      quantity: -60,
      correction_of: debit.id,
    });
    await expect(service.recordUsage({ ...debit, quantity: '61.000000' })).rejects.toBeInstanceOf(
      UsageIdentityConflictError,
    );
    await expect(
      service.getUsageSummary(organizationId, {
        start: '2026-08-11T00:00:00.000Z',
        end: '2026-08-12T00:00:00.000Z',
      }),
    ).resolves.toEqual([
      expect.objectContaining({ quantity: '0.000000', creditsCharged: '0.0000' }),
    ]);
  });
});
