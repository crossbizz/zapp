import { newId } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { SERVICE_TOKEN_HEADER } from '../src/internal/service-auth.js';
import type { UsageLedgerRepository } from '../src/usage/ledger.js';
import { buildHarness, type Harness } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(async (harness) => {
      await harness.app.close();
    }),
  );
});

describe('OPS-1B internal usage route', () => {
  it('accepts keyed non-model usage only from an allowlisted service', async () => {
    const organizationId = newId('org');
    const repository: UsageLedgerRepository = {
      recordUsage: (entry) =>
        Promise.resolve({
          ledgerRowId: 'usage_recorded',
          row: {} as never,
          event: {
            event_name: entry.category,
            external_customer_id: entry.organizationId,
            event_id: 'usage_recorded',
            timestamp: entry.occurredAt,
            properties: {
              project_id: entry.projectId,
              run_id: entry.runId,
              task_id: entry.taskId,
              quantity: Number(entry.quantity),
              unit: entry.unit,
              provider: entry.provider,
            },
          },
        }),
      getUsageSummary: () => Promise.resolve({ byCategory: [], byProject: [], byRun: [] }),
    };
    const built = buildHarness({
      tenantDb: new InMemoryTenantData().factory,
      usageLedger: repository,
    });
    harnesses.push(built);
    const token = await built.serviceTokens.issue('sandbox-service', {
      aud: 'control-api:usage.ingest',
    });
    const response = await built.app.inject({
      method: 'POST',
      url: '/internal/usage',
      headers: { [SERVICE_TOKEN_HEADER]: token },
      payload: {
        operationKey: 'sandbox-usage-01',
        organizationId,
        projectId: null,
        runId: null,
        taskId: null,
        category: 'sandbox_cpu_seconds',
        provider: 'modal',
        quantity: '1.000000',
        unit: 'cpu_seconds',
        costUsd: '0.000010',
        creditsCharged: '0.0010',
        occurredAt: '2026-08-11T12:00:00.000Z',
        metadata: {},
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ ledgerRowId: 'usage_recorded' });
  });
});
