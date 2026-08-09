import { describe, expect, it } from 'vitest';

import { createAccountingReconcilerLifecycle } from '../../src/usage/reconciliation.js';

describe('OPS-1A production accounting reconciliation lifecycle', () => {
  it('reconciles before readiness, stays single-flight and drains before close', async () => {
    let resolvePoll!: () => void;
    const blockedPoll = new Promise<{ acquired: boolean; mirrored: number }>((resolve) => {
      resolvePoll = () => {
        resolve({ acquired: true, mirrored: 1 });
      };
    });
    const scheduled: (() => void)[] = [];
    const calls: number[] = [];
    const lifecycle = createAccountingReconcilerLifecycle({
      reconciler: {
        runOnce(limit) {
          calls.push(limit);
          return calls.length === 1
            ? Promise.resolve({ acquired: true, mirrored: 1 })
            : blockedPoll;
        },
      },
      batchSize: 50,
      intervalMs: 30_000,
      timers: {
        setInterval(callback) {
          scheduled.push(callback);
          return 11;
        },
        clearInterval(handle) {
          expect(handle).toBe(11);
        },
      },
    });

    await lifecycle.start();
    expect(calls).toEqual([50]);
    scheduled[0]?.();
    scheduled[0]?.();
    await Promise.resolve();
    expect(calls).toEqual([50, 50]);

    const closing = lifecycle.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolvePoll();
    await closing;
    expect(closed).toBe(true);
  });
});
