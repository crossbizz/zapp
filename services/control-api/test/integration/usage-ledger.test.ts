import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { newId } from '@zapp/contracts';
import { createDb, type Db } from '@zapp/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createUsageEventConsumer,
  createUsageEventConsumerLifecycle,
  createUsageOutboxPublisher,
  createDatabaseUsageOutboxDeliveryPort,
} from '../../src/usage/outbox.js';
import { createUsageLedgerRepository, type UsageEntry } from '../../src/usage/ledger.js';
import {
  createDatabaseUsageCorrectionJournal,
  createDatabaseUsageReconciliationSource,
} from '../../src/usage/reconciliation.js';
import { createDatabaseDailyStorageClaim } from '../../src/usage/collectors/storage.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

const APPEND_ONLY_GRANT_MIGRATION = fileURLToPath(
  new URL(
    '../../../../packages/db/drizzle/0004_append_only_truncate_and_app_role.sql',
    import.meta.url,
  ),
);

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

  it('records a correction with the shipped append-only application-role privileges', async () => {
    const original = await createUsageLedgerRepository({ database: database.db }).recordUsage(
      entry(),
    );
    const role = `zapp_usage_app_${String(process.pid)}_${String(Date.now())}`;
    const password = `test_${newId('evt')}`;
    const databaseName = decodeURIComponent(new URL(database.url).pathname.slice(1));
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(databaseName)) {
      throw new Error('integration database name is not a safe PostgreSQL identifier');
    }
    let applicationDatabase: Db | undefined;
    let roleCreated = false;

    try {
      await database.sql.unsafe(`create role ${role} login password '${password}'`);
      roleCreated = true;
      await database.sql.unsafe(`grant connect on database "${databaseName}" to ${role}`);
      await database.sql.unsafe(`grant usage on schema public to ${role}`);
      await database.sql.unsafe(
        `grant select, insert, update, delete, truncate on usage_ledger, audit_events to ${role}`,
      );
      await database.sql.unsafe(`grant select, insert on usage_outbox to ${role}`);
      const statements = readFileSync(APPEND_ONLY_GRANT_MIGRATION, 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter((statement) => statement !== '');
      await database.sql.begin(async (tx) => {
        await tx.unsafe(`set local zapp.app_role = '${role}'`);
        for (const statement of statements) await tx.unsafe(statement);
      });
      const [privileges] = await database.sql<
        { canInsert: boolean; canSelect: boolean; canUpdate: boolean }[]
      >`
        select
          has_table_privilege(${role}, 'usage_ledger', 'INSERT') as "canInsert",
          has_table_privilege(${role}, 'usage_ledger', 'SELECT') as "canSelect",
          has_table_privilege(${role}, 'usage_ledger', 'UPDATE') as "canUpdate"
      `;
      expect(privileges).toEqual({ canInsert: true, canSelect: true, canUpdate: false });

      const applicationUrl = new URL(database.url);
      applicationUrl.username = role;
      applicationUrl.password = password;
      applicationDatabase = createDb(applicationUrl.toString());
      const correction = await createUsageLedgerRepository({
        database: applicationDatabase.db,
      }).recordUsage(
        entry({
          operationKey: 'application-role-correction',
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
      const [after] = await database.sql<{ canUpdate: boolean }[]>`
        select has_table_privilege(${role}, 'usage_ledger', 'UPDATE') as "canUpdate"
      `;
      expect(after).toEqual({ canUpdate: false });
    } finally {
      await applicationDatabase?.close();
      if (roleCreated) {
        await database.sql.unsafe(`drop owned by ${role}`);
        await database.sql.unsafe(`drop role ${role}`);
      }
    }
  });

  it('allows proportional partial corrections up to the original and preserves retry identity', async () => {
    const ledger = createUsageLedgerRepository({ database: database.db });
    const original = await ledger.recordUsage(entry());
    const shared = {
      projectId: original.row.projectId,
      runId: original.row.runId,
      taskId: original.row.taskId,
      metadata: { correction_of: original.ledgerRowId },
    } as const;
    const firstInput = entry({
      ...shared,
      operationKey: 'sandbox-cpu-partial-1',
      quantity: '-1.000000',
      costUsd: '-0.000010',
      creditsCharged: '-0.0010',
    });
    const first = await ledger.recordUsage(firstInput);
    await ledger.recordUsage(
      entry({
        ...shared,
        operationKey: 'sandbox-cpu-partial-2',
        quantity: '-2.000000',
        costUsd: '-0.000020',
        creditsCharged: '-0.0020',
      }),
    );

    await expect(ledger.recordUsage(firstInput)).resolves.toEqual(first);
    const [stored] = await database.sql<{ events: string; rows: string }[]>`
      select
        (select count(*)::text from usage_ledger where organization_id = ${organizationId}) as rows,
        (select count(*)::text from usage_outbox where organization_id = ${organizationId}) as events
    `;
    expect(stored).toEqual({ rows: '3', events: '3' });
  });

  it('serializes concurrent partial corrections so their aggregate cannot exceed the original', async () => {
    const ledger = createUsageLedgerRepository({ database: database.db });
    const original = await ledger.recordUsage(entry());
    const shared = {
      projectId: original.row.projectId,
      runId: original.row.runId,
      taskId: original.row.taskId,
      quantity: '-2.000000',
      costUsd: '-0.000020',
      creditsCharged: '-0.0020',
      metadata: { correction_of: original.ledgerRowId },
    } as const;

    const results = await Promise.allSettled([
      ledger.recordUsage(entry({ ...shared, operationKey: 'concurrent-correction-a' })),
      ledger.recordUsage(entry({ ...shared, operationKey: 'concurrent-correction-b' })),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    const [stored] = await database.sql<{ events: string; rows: string }[]>`
      select
        (select count(*)::text from usage_ledger where organization_id = ${organizationId}) as rows,
        (select count(*)::text from usage_outbox where organization_id = ${organizationId}) as events
    `;
    expect(stored).toEqual({ rows: '2', events: '2' });
  });

  it('rejects nonexistent and cross-organization correction targets before append', async () => {
    const ledger = createUsageLedgerRepository({ database: database.db });
    const original = await ledger.recordUsage(entry());
    const otherOrganizationId = newId('org');
    await database.sql`
      insert into organizations (id, name, slug)
      values (${otherOrganizationId}, 'Other usage ledger', ${otherOrganizationId})
    `;

    await expect(
      ledger.recordUsage(
        entry({
          operationKey: 'missing-correction',
          quantity: '-1.000000',
          costUsd: '-0.000010',
          creditsCharged: '-0.0010',
          metadata: { correction_of: 'usage_missing' },
        }),
      ),
    ).rejects.toThrow('valid positive original');
    await expect(
      ledger.recordUsage(
        entry({
          operationKey: 'cross-org-correction',
          organizationId: otherOrganizationId,
          quantity: '-1.000000',
          costUsd: '-0.000010',
          creditsCharged: '-0.0010',
          metadata: { correction_of: original.ledgerRowId },
        }),
      ),
    ).rejects.toThrow('valid positive original');

    const [stored] = await database.sql<{ events: string; rows: string }[]>`
      select
        (select count(*)::text from usage_ledger) as rows,
        (select count(*)::text from usage_outbox) as events
    `;
    expect(stored).toEqual({ rows: '1', events: '1' });
  });

  it('rejects correction attribution mismatches before append', async () => {
    const ledger = createUsageLedgerRepository({ database: database.db });
    const original = await ledger.recordUsage(entry());
    const base = {
      projectId: original.row.projectId,
      runId: original.row.runId,
      taskId: original.row.taskId,
      quantity: '-1.000000',
      costUsd: '-0.000010',
      creditsCharged: '-0.0010',
      metadata: { correction_of: original.ledgerRowId },
    } as const;
    const mismatches: readonly Partial<UsageEntry>[] = [
      { category: 'sandbox_mem_gib_seconds' },
      { projectId: newId('proj') },
      { runId: newId('run') },
      { taskId: newId('task') },
      { provider: 'another-provider' },
      { unit: 'another-unit' },
    ];

    for (const [index, mismatch] of mismatches.entries()) {
      await expect(
        ledger.recordUsage(
          entry({ ...base, ...mismatch, operationKey: `mismatched-correction-${String(index)}` }),
        ),
      ).rejects.toThrow('must match the original attribution');
    }
    const [stored] = await database.sql<{ events: string; rows: string }[]>`
      select
        (select count(*)::text from usage_ledger where organization_id = ${organizationId}) as rows,
        (select count(*)::text from usage_outbox where organization_id = ${organizationId}) as events
    `;
    expect(stored).toEqual({ rows: '1', events: '1' });
  });

  it('rejects non-proportional, wrong-signed, and aggregate over-corrections', async () => {
    const ledger = createUsageLedgerRepository({ database: database.db });
    const original = await ledger.recordUsage(entry());
    const base = {
      projectId: original.row.projectId,
      runId: original.row.runId,
      taskId: original.row.taskId,
      quantity: '-1.000000',
      creditsCharged: '-0.0010',
      metadata: { correction_of: original.ledgerRowId },
    } as const;

    await expect(
      ledger.recordUsage(
        entry({ ...base, operationKey: 'non-proportional', costUsd: '-0.000005' }),
      ),
    ).rejects.toThrow('must be proportional');
    await expect(
      ledger.recordUsage(entry({ ...base, operationKey: 'wrong-sign', costUsd: '0.000010' })),
    ).rejects.toThrow('must be non-positive');
    await ledger.recordUsage(
      entry({ ...base, operationKey: 'partial-before-over', costUsd: '-0.000010' }),
    );
    await expect(
      ledger.recordUsage(
        entry({
          ...base,
          operationKey: 'aggregate-over-correction',
          quantity: '-3.000000',
          costUsd: '-0.000030',
          creditsCharged: '-0.0030',
        }),
      ),
    ).rejects.toThrow('exceeds the original');

    const [stored] = await database.sql<{ events: string; rows: string }[]>`
      select
        (select count(*)::text from usage_ledger where organization_id = ${organizationId}) as rows,
        (select count(*)::text from usage_outbox where organization_id = ${organizationId}) as events
    `;
    expect(stored).toEqual({ rows: '2', events: '2' });
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
      consumer: createUsageEventConsumer(
        {
          ingest: (event) => {
            expect(event.event_id).toBe(recorded.ledgerRowId);
            return available
              ? Promise.resolve()
              : Promise.reject(new Error('Flexprice unavailable'));
          },
        },
        createDatabaseUsageOutboxDeliveryPort(database.db),
      ),
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
    await vi.waitFor(() => {
      expect(deleted).toEqual(['receipt-1']);
    });
    const [outbox] = await database.sql<{ status: string; delivered_at: string | null }[]>`
      select status, delivered_at from usage_outbox where ledger_row_id = ${recorded.ledgerRowId}
    `;
    expect(outbox?.status).toBe('delivered');
    expect(outbox?.delivered_at).not.toBeNull();
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
      byCategory: [{ category: 'sandbox_cpu_seconds', credits: '0.0000' }],
      byProject: [{ projectId: original.row.projectId, credits: '0.0000' }],
      byRun: [{ runId: original.row.runId, credits: '0.0000' }],
    });
  });

  it('denominates project and run burn-down in credits across heterogeneous usage units', async () => {
    const ledger = createUsageLedgerRepository({ database: database.db });
    const projectId = newId('proj');
    const runId = newId('run');
    await ledger.recordUsage(
      entry({
        operationKey: 'mixed-model-tokens',
        projectId,
        runId,
        category: 'model_input_tokens',
        provider: 'anthropic',
        quantity: '1200.000000',
        unit: 'tokens',
        creditsCharged: '1.2000',
      }),
    );
    await ledger.recordUsage(
      entry({
        operationKey: 'mixed-sandbox-cpu',
        projectId,
        runId,
        quantity: '30.000000',
        creditsCharged: '0.3000',
      }),
    );

    await expect(
      ledger.getUsageSummary(organizationId, {
        from: '2026-08-11T00:00:00.000Z',
        to: '2026-08-12T00:00:00.000Z',
      }),
    ).resolves.toEqual({
      byCategory: [
        { category: 'model_input_tokens', credits: '1.2000' },
        { category: 'sandbox_cpu_seconds', credits: '0.3000' },
      ],
      byProject: [{ projectId, credits: '1.5000' }],
      byRun: [{ runId, credits: '1.5000' }],
    });
  });

  it('rejects a category outside the persisted FND-5 enum before inserting', async () => {
    const ledger = createUsageLedgerRepository({ database: database.db });
    await expect(
      ledger.recordUsage(entry({ category: 'invented_category' } as unknown as UsageEntry)),
    ).rejects.toThrow('category');
  });

  it('keeps an accepted correction pending until analytics converge, then permits a residual', async () => {
    const events: unknown[] = [];
    const journal = createDatabaseUsageCorrectionJournal({
      database: database.db,
      now: () => new Date('2026-08-12T01:00:00.000Z'),
      ingest: {
        ingest(event) {
          events.push(event);
          return Promise.resolve();
        },
      },
    });
    const correction = {
      organizationId,
      projectId: null,
      runId: null,
      taskId: null,
      category: 'artifact_storage' as const,
      from: '2026-08-10T00:00:00.000Z',
      to: '2026-08-11T00:00:00.000Z',
      targetQuantity: '2.000000',
      observedQuantity: '1.500000',
      deltaQuantity: '0.500000',
    };

    await expect(journal.correct(correction)).resolves.toBe('submitted');
    await expect(journal.correct(correction)).resolves.toBe('pending');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_name: 'artifact_storage',
      external_customer_id: organizationId,
      timestamp: '2026-08-10T23:59:59.999Z',
      properties: { project_id: null, run_id: null, task_id: null, quantity: 0.5 },
    });
    const [stored] = await database.sql<
      {
        rows: string;
        status: string;
        attempts: number;
        accepted: boolean;
        confirmed: boolean;
      }[]
    >`
      select
        count(*)::text as rows,
        min(status) as status,
        max(attempts)::integer as attempts,
        bool_and(delivered_at is not null) as accepted,
        bool_or(confirmed_at is not null) as confirmed
      from usage_reconciliation_corrections
      where organization_id = ${organizationId}
    `;
    expect(stored).toEqual({
      rows: '1',
      status: 'pending',
      attempts: 1,
      accepted: true,
      confirmed: false,
    });

    await expect(
      journal.confirm({
        organizationId: correction.organizationId,
        projectId: correction.projectId,
        runId: correction.runId,
        taskId: correction.taskId,
        from: correction.from,
        to: correction.to,
        category: correction.category,
        targetQuantity: correction.targetQuantity,
        observedQuantity: correction.targetQuantity,
      }),
    ).resolves.toBe('confirmed');
    await expect(
      journal.correct({
        ...correction,
        observedQuantity: '1.750000',
        deltaQuantity: '0.250000',
      }),
    ).resolves.toBe('submitted');
    expect(events).toHaveLength(2);
    const [afterResidual] = await database.sql<
      { rows: string; confirmed: string; pending: string }[]
    >`
      select
        count(*)::text as rows,
        count(*) filter (where status = 'confirmed')::text as confirmed,
        count(*) filter (where status = 'pending')::text as pending
      from usage_reconciliation_corrections
      where organization_id = ${organizationId}
    `;
    expect(afterResidual).toEqual({ rows: '2', confirmed: '1', pending: '1' });
  });

  it('serializes concurrent correction creation and submits only the persisted winner', async () => {
    const events: unknown[] = [];
    let releaseFirstIngest: (() => void) | undefined;
    const firstIngestGate = new Promise<void>((resolve) => {
      releaseFirstIngest = resolve;
    });
    const journal = createDatabaseUsageCorrectionJournal({
      database: database.db,
      now: () => new Date('2026-08-12T01:00:00.000Z'),
      ingest: {
        async ingest(event) {
          events.push(event);
          if (events.length === 1) await firstIngestGate;
        },
      },
    });
    const base = {
      organizationId,
      projectId: null,
      runId: null,
      taskId: null,
      category: 'artifact_storage' as const,
      from: '2026-08-10T00:00:00.000Z',
      to: '2026-08-11T00:00:00.000Z',
      targetQuantity: '2.000000',
    };

    const first = journal.correct({
      ...base,
      observedQuantity: '1.500000',
      deltaQuantity: '0.500000',
    });
    for (let attempt = 0; attempt < 100 && events.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const second = journal.correct({
      ...base,
      observedQuantity: '1.250000',
      deltaQuantity: '0.750000',
    });

    await expect(second).resolves.toBe('pending');
    releaseFirstIngest?.();
    await expect(first).resolves.toBe('submitted');
    expect(events).toHaveLength(1);
    const [stored] = await database.sql<{ rows: string; attempts: number }[]>`
      select count(*)::text as rows, max(attempts)::integer as attempts
      from usage_reconciliation_corrections
      where organization_id = ${organizationId}
    `;
    expect(stored).toEqual({ rows: '1', attempts: 1 });
  });

  it('claims a daily storage bucket once across replicas and persists completion', async () => {
    const now = () => new Date('2026-08-12T01:00:00.000Z');
    const first = createDatabaseDailyStorageClaim({
      database: database.db,
      owner: 'replica-first',
      now,
    });
    const second = createDatabaseDailyStorageClaim({
      database: database.db,
      owner: 'replica-second',
      now,
    });
    const bucket = {
      from: '2026-08-10T00:00:00.000Z',
      to: '2026-08-11T00:00:00.000Z',
    };

    const claim = await first.claim(bucket);
    expect(claim).toMatchObject({ status: 'acquired' });
    if (claim.status !== 'acquired') throw new Error('expected first replica to own the bucket');
    await expect(second.claim(bucket)).resolves.toEqual({ status: 'busy' });
    await expect(
      first.runFenced(bucket, claim.leaseToken, () => Promise.resolve('safe')),
    ).resolves.toBe('safe');
    await first.complete(bucket, claim.leaseToken);
    await expect(second.claim(bucket)).resolves.toEqual({ status: 'completed' });
  });

  it('derives completed and runless nullable scopes from the closed ledger window', async () => {
    const ledger = createUsageLedgerRepository({ database: database.db });
    await ledger.recordUsage(
      entry({
        operationKey: 'runless-artifact-storage',
        projectId: null,
        runId: null,
        taskId: null,
        category: 'artifact_storage',
        provider: 'r2',
        quantity: '2.000000',
        unit: 'gib',
        costUsd: '0.000020',
        creditsCharged: '0.0020',
      }),
    );
    const source = createDatabaseUsageReconciliationSource(database.db);
    const window = {
      from: '2026-08-11T00:00:00.000Z',
      to: '2026-08-12T00:00:00.000Z',
    };

    await expect(source.scopes.list(window)).resolves.toContainEqual({
      organizationId,
      projectId: null,
      runId: null,
      taskId: null,
    });
    await expect(
      source.ledger.readTotal(
        { organizationId, projectId: null, runId: null, taskId: null, ...window },
        'artifact_storage',
      ),
    ).resolves.toBe('2.000000');
  });
});
