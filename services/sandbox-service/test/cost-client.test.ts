import { describe, expect, it } from 'vitest';

import { createControlPlaneUsageLedgerClient } from '../src/cost/client.js';
import type { UsageLedgerRow } from '../src/cost/recorder.js';

describe('sandbox usage ledger production client', () => {
  it('authenticates and posts recorder rows to the public control-plane accounting seam', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const secrets = { secret: 'x'.repeat(32) };
    const client = createControlPlaneUsageLedgerClient({
      baseUrl: 'https://control.zapp.test',
      serviceTokens: secrets,
      fetch(input, init) {
        requests.push({ url: input, init });
        return Promise.resolve(
          new Response(JSON.stringify({ ledgerRowId: 'usage_recorded', event: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });
    const row = {
      id: `usage_${'a'.repeat(64)}_sandbox_cpu_seconds`,
      organizationId: 'org_01J00000000000000000000000',
      projectId: 'proj_01J00000000000000000000000',
      runId: 'run_01J00000000000000000000000',
      taskId: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      category: 'sandbox_cpu_seconds',
      provider: 'modal',
      quantity: '1.500000',
      unit: 'cpu_second',
      costUsd: '0.000010',
      creditsCharged: '0.0010',
      occurredAt: '2026-08-11T12:00:00.000Z',
    } satisfies UsageLedgerRow;

    await client.appendIfAbsent(row);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://control.zapp.test/internal/usage');
    const requestBody = requests[0]?.init.body;
    if (typeof requestBody !== 'string') throw new Error('usage request body was not JSON');
    expect(JSON.parse(requestBody)).toEqual({
      operationKey: row.id,
      organizationId: row.organizationId,
      projectId: row.projectId,
      runId: row.runId,
      taskId: row.taskId,
      category: row.category,
      provider: row.provider,
      quantity: row.quantity,
      unit: row.unit,
      costUsd: row.costUsd,
      creditsCharged: row.creditsCharged,
      occurredAt: row.occurredAt,
      metadata: {},
    });
    const token = new Headers(requests[0]?.init.headers).get('x-zapp-service-token') ?? '';
    const encodedPayload = token.split('.')[1] ?? '';
    expect(JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))).toMatchObject({
      sub: 'sandbox-service',
      aud: 'control-api:usage.ingest',
    });
  });
});
