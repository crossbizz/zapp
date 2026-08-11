import { expect, it } from 'vitest';

import { CreditBalanceExhaustedError } from '../../src/usage/limits.js';
import { createCreditBalanceExhaustionProducer } from '../../src/usage/reconciliation.js';

it('signals every active workflow with a stable idempotency key after wallet exhaustion', async () => {
  const signals: unknown[] = [];
  const producer = createCreditBalanceExhaustionProducer({
    organizations: { listActiveOrganizationIds: () => Promise.resolve(['org_01J00000000000000000000000']) },
    activeRuns: { list: () => Promise.resolve(['run_01J00000000000000000000000']) },
    creditBalance: {
      availableCredits: () => Promise.reject(new Error('not used')),
      requireRunAdmission: () => Promise.reject(new CreditBalanceExhaustedError()),
    },
    orchestrator: {
      startRun: () => Promise.resolve(),
      signalRun: (input) => { signals.push(input); return Promise.resolve({ applied: true }); },
    },
  });

  await producer.runOnce();
  await producer.runOnce();
  const [first, second] = signals as Array<{
    readonly runId: string;
    readonly workflowId: string;
    readonly signal: string;
    readonly operationKey: string;
  }>;
  if (first === undefined) throw new Error('expected the producer to signal an active run');
  expect(first).toMatchObject({
    runId: 'run_01J00000000000000000000000',
    workflowId: 'run_01J00000000000000000000000',
    signal: 'credit_balance_exhausted',
  });
  expect(first.operationKey).toMatch(/^op_[a-f0-9]{64}$/u);
  expect(second?.operationKey).toBe(first.operationKey);
});
