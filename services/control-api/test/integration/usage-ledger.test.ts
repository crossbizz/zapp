import { newId } from '@zapp/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createUsageEventConsumer,
  createUsageEventConsumerLifecycle,
  createUsageOutboxPublisher,
} from '../../src/usage/outbox.js';
import { createUsageLedgerRepository, type UsageEntry } from '../../src/usage/ledger.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

describe.skipIf(!hasDatabase)('OPS-1B append-only usage ledger', () => {
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
      values (${organizationId}, 'Usage ledger', ${organizationId})
    `;
  });

  function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
    return {
      operationKey: 'sandbox-cpu-001',
      organizationId,
      projectId: newId('proj'),
      runId: newId('run'),
      taskId: newId('task'),
      category: 'sandbox_cpu_seconds',
      provider: 'modal',
      quantity: '3.000000',
      unit: 'cpu_seconds',
      costUsd: '0.000030',
      creditsCharged: '0.0030',
      occurredAt: '2026-08-11T12:00:00.000Z',
      metadata: {},
      ...overrides,
    };
  }

  it('appends one immutable row and queues the exact Flexprice event id', async () => {
    const result = await createUsageLedgerRepository({ database: database.db }).recordUsage(
      entry(),
    );

    expect(result.event).toEqual({
      event_name: 'sandbox_cpu_seconds',
      external_customer_id: organizationId,
      event_id: result.ledgerRowId,
      timestamp: '2026-08-11T12:00:00.000Z',
      properties: {
        project_id: result.row.projectId,
        run_id: result.row.runId,
        task_id: result.row.taskId,
        quantity: 3,
        unit: 'cpu_seconds',
        provider: 'modal',
      },
    });
    const [stored] = await database.sql<{ rows: string; events: string; event_id: string }[]>`
      select
        (select count(*)::text from usage_ledger where organization_id = ${organizationId}) as rows,
        (select count(*)::text from usage_outbox where organization_id = ${organizationId}) as events,
        (select event_json ->> 'event_id' from usage_outbox where organization_id = ${organizationId}) as event_id
    `;
    expect(stored).toEqual({ rows: '1', events: '1', event_id: result.ledgerRowId });
  });

  it('returns the original ledger row and event id for a stable retry identity', async () => {
    const ledger = createUsageLedgerRepository({ database: database.db });
    const input = entry();
    const first = await ledger.recordUsage(input);
    const retried = await ledger.recordUsage(input);

    expect(retried).toEqual(first);
    const [stored] = await database.sql<{ rows: string; events: string }[]>`
      select
        (select count(*)::text from usage_ledger where organization_id = ${organizationId}) as rows,
        (select count(*)::text from usage_outbox where organization_id = ${organizationId}) as events
    `;
    expect(stored).toEqual({ rows: '1', events: '1' });
  });

  it('keeps the event queued through a Flexprice outage and drains it later', async () => {
    const ledger = createUsageLedgerRepository({ database: database.db });
    const recorded = await ledger.recordUsage(entry());
    const published: string[] = [];
    await createUsageOutboxPublisher({
      database: database.db,
      queue: {
        send: (body) => {
          published.push(body);
          return Promise.resolve();
        },
      },
    }).publishOnce(10);

    const deleted: string[] = [];
    const scheduled: (() => void)[] = [];
    let available = false;
    const lifecycle = createUsageEventConsumerLifecycle({
      queue: {
        receive: () => Promise.resolve([{ body: published[0] ?? '', receiptHandle: 'receipt-1' }]),
        delete: (receiptHandle) => {
          deleted.push(receiptHandle);
          return Promise.resolve();
        },
      },
      consumer: createUsageEventConsumer({
        ingest: (event) => {
          expect(event.event_id).toBe(recorded.ledgerRowId);
          return available ? Promise.resolve() : Promise.reject(new Error('Flexprice unavailable'));
        },
      }),
      batchSize: 1,
      waitTimeSeconds: 0,
      visibilityTimeoutSeconds: 1,
      intervalMs: 1,
      timers: {
        setInterval(callback) {
          scheduled.push(callback);
          return 1;
        },
        clearInterval() {},
      },
    });

    await lifecycle.start();
    expect(deleted).toEqual([]);
    available = true;
    scheduled[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleted).toEqual(['receipt-1']);
    await lifecycle.close();
  });

  it('nets a negative compensating entry to zero and queues a negative event', async () => {
    const ledger = createUsageLedgerRepository({ database: database.db });
    const original = await ledger.recordUsage(entry());
    const correction = await ledger.recordUsage(
      entry({
        operationKey: 'sandbox-cpu-001-correction',
        projectId: original.row.projectId,
        runId: original.row.runId,
        taskId: original.row.taskId,
        quantity: '-3.000000',
        costUsd: '-0.000030',
        creditsCharged: '-0.0030',
        metadata: { correction_of: original.ledgerRowId },
      }),
    );

    expect(correction.event.properties.quantity).toBe(-3);
    await expect(
      ledger.getUsageSummary(organizationId, {
        from: '2026-08-11T00:00:00.000Z',
        to: '2026-08-12T00:00:00.000Z',
      }),
    ).resolves.toEqual({
      byCategory: [{ category: 'sandbox_cpu_seconds', quantity: '0.000000' }],
      byProject: [{ projectId: original.row.projectId, quantity: '0.000000' }],
      byRun: [{ runId: original.row.runId, quantity: '0.000000' }],
    });
  });

  it('rejects a category outside the persisted FND-5 enum before inserting', async () => {
    const ledger = createUsageLedgerRepository({ database: database.db });
    await expect(
      ledger.recordUsage(entry({ category: 'invented_category' } as unknown as UsageEntry)),
    ).rejects.toThrow('category');
  });
});
