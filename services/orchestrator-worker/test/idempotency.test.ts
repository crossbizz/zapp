import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it, vi } from 'vitest';

import {
  executeIdempotentActivity,
  hashActivityInput,
  type ActivityIdempotencyClaim,
  type ActivityIdempotencyStore,
} from '../src/activities/idempotency.js';

interface StoredClaim {
  readonly activityType: string;
  readonly inputHash: string;
  ownerId: string;
  leaseUntil: number;
  resultHash?: string;
  result?: unknown;
}

class MemoryActivityIdempotencyStore implements ActivityIdempotencyStore {
  readonly rows = new Map<string, StoredClaim>();
  now = 1_000;

  claim(input: {
    readonly idempotencyKey: string;
    readonly activityType: string;
    readonly inputHash: string;
    readonly ownerId: string;
    readonly leaseMs: number;
  }): Promise<ActivityIdempotencyClaim> {
    const existing = this.rows.get(input.idempotencyKey);
    if (existing === undefined) {
      this.rows.set(input.idempotencyKey, {
        activityType: input.activityType,
        inputHash: input.inputHash,
        ownerId: input.ownerId,
        leaseUntil: this.now + input.leaseMs,
      });
      return Promise.resolve({ status: 'acquired' });
    }
    if (
      existing.activityType !== input.activityType ||
      existing.inputHash !== input.inputHash
    ) {
      return Promise.resolve({ status: 'conflict' });
    }
    if (existing.resultHash !== undefined) {
      return Promise.resolve({
        status: 'replay',
        resultHash: existing.resultHash,
        result: existing.result,
      });
    }
    if (existing.leaseUntil > this.now) return Promise.resolve({ status: 'in_progress' });
    existing.ownerId = input.ownerId;
    existing.leaseUntil = this.now + input.leaseMs;
    return Promise.resolve({ status: 'acquired' });
  }

  renew(input: {
    readonly idempotencyKey: string;
    readonly ownerId: string;
    readonly leaseMs: number;
  }): Promise<boolean> {
    const existing = this.rows.get(input.idempotencyKey);
    if (existing === undefined || existing.ownerId !== input.ownerId) return Promise.resolve(false);
    existing.leaseUntil = this.now + input.leaseMs;
    return Promise.resolve(true);
  }

  complete(input: {
    readonly idempotencyKey: string;
    readonly ownerId: string;
    readonly resultHash: string;
    readonly result: unknown;
  }): Promise<boolean> {
    const existing = this.rows.get(input.idempotencyKey);
    if (existing === undefined || existing.ownerId !== input.ownerId) return Promise.resolve(false);
    existing.resultHash = input.resultHash;
    existing.result = input.result;
    return Promise.resolve(true);
  }

  release(input: {
    readonly idempotencyKey: string;
    readonly ownerId: string;
  }): Promise<void> {
    const existing = this.rows.get(input.idempotencyKey);
    if (existing?.ownerId === input.ownerId && existing.resultHash === undefined) {
      this.rows.delete(input.idempotencyKey);
    }
    return Promise.resolve();
  }
}

const execute = (
  store: ActivityIdempotencyStore,
  input: {
    readonly activityType?: string;
    readonly args?: readonly unknown[];
    readonly ownerId?: string;
    readonly next: () => Promise<unknown>;
  },
): Promise<unknown> =>
  executeIdempotentActivity({
    store,
    activityType: input.activityType ?? 'commitAndPush',
    args: input.args ?? [{ idempotencyKey: 'run:test:commit', value: 1 }],
    ownerId: input.ownerId ?? 'workflow:activity:1',
    leaseMs: 30_000,
    renewIntervalMs: 10_000,
    next: input.next,
  });

describe('AR-9 activity idempotency middleware', () => {
  it('executes once and replays the completed JSON result with its stored hash', async () => {
    const store = new MemoryActivityIdempotencyStore();
    const mutation = vi.fn(() =>
      Promise.resolve({ commitSha: 'a'.repeat(40), nested: { ok: true } }),
    );

    const first = await execute(store, { next: mutation });
    const replay = await execute(store, { ownerId: 'workflow:activity:2', next: mutation });

    expect(first).toEqual(replay);
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(store.rows.get('run:test:commit')?.resultHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('durably replays void and JSON-null activity results without rerunning the mutation', async () => {
    const voidStore = new MemoryActivityIdempotencyStore();
    const voidMutation = vi.fn(() => Promise.resolve(undefined));

    await expect(execute(voidStore, { next: voidMutation })).resolves.toBeUndefined();
    await expect(
      execute(voidStore, { ownerId: 'workflow:activity:2', next: voidMutation }),
    ).resolves.toBeUndefined();
    expect(voidMutation).toHaveBeenCalledTimes(1);

    const nullStore = new MemoryActivityIdempotencyStore();
    const nullMutation = vi.fn(() => Promise.resolve(null));

    await expect(execute(nullStore, { next: nullMutation })).resolves.toBeNull();
    await expect(
      execute(nullStore, { ownerId: 'workflow:activity:2', next: nullMutation }),
    ).resolves.toBeNull();
    expect(nullMutation).toHaveBeenCalledTimes(1);
  });

  it('fails closed when one key is reused for changed input or another activity', async () => {
    const store = new MemoryActivityIdempotencyStore();
    await execute(store, { next: () => Promise.resolve({ ok: true }) });

    for (const attempted of [
      execute(store, {
        args: [{ idempotencyKey: 'run:test:commit', value: 2 }],
        next: () => Promise.resolve({ ok: false }),
      }),
      execute(store, {
        activityType: 'ensureWorkspace',
        next: () => Promise.resolve({ ok: false }),
      }),
    ]) {
      await expect(attempted).rejects.toMatchObject({
        type: 'activity_idempotency_conflict',
        nonRetryable: true,
      } satisfies Partial<ApplicationFailure>);
    }
  });

  it('makes a live concurrent claim retryable and recovers it only after lease expiry', async () => {
    const store = new MemoryActivityIdempotencyStore();
    const args = [{ idempotencyKey: 'run:test:commit', value: 1 }];
    await store.claim({
      idempotencyKey: 'run:test:commit',
      activityType: 'commitAndPush',
      inputHash: hashActivityInput('commitAndPush', args),
      ownerId: 'workflow:activity:1',
      leaseMs: 30_000,
    });

    await expect(
      execute(store, {
        ownerId: 'workflow:activity:2',
        next: () => Promise.resolve({ ok: true }),
      }),
    ).rejects.toMatchObject({
      type: 'activity_idempotency_in_progress',
      nonRetryable: false,
      nextRetryDelay: 30_000,
    } satisfies Partial<ApplicationFailure>);

    store.now += 30_001;
    await expect(
      execute(store, {
        ownerId: 'workflow:activity:2',
        next: () => Promise.resolve({ recovered: true }),
      }),
    ).resolves.toEqual({ recovered: true });
  });

  it('releases a failed attempt so Temporal can retry the underlying keyed mutation', async () => {
    const store = new MemoryActivityIdempotencyStore();
    await expect(
      execute(store, {
        next: () => Promise.reject(new Error('transient')),
      }),
    ).rejects.toThrow('transient');

    await expect(
      execute(store, {
        ownerId: 'workflow:activity:2',
        next: () => Promise.resolve({ retried: true }),
      }),
    ).resolves.toEqual({ retried: true });
  });

  it('rejects a mutating activity without a durable key before calling it', async () => {
    const store = new MemoryActivityIdempotencyStore();
    const mutation = vi.fn(() => Promise.resolve({ unsafe: true }));

    await expect(
      execute(store, { args: [{ runId: 'run_without_key' }], next: mutation }),
    ).rejects.toMatchObject({
      type: 'activity_idempotency_key_required',
      nonRetryable: true,
    } satisfies Partial<ApplicationFailure>);
    expect(mutation).not.toHaveBeenCalled();
  });
});
