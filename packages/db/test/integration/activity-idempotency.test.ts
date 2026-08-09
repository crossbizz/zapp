import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createActivityIdempotencyRepository } from '../../src/activity-idempotency.js';
import { activityIdempotency } from '../../src/schema/execution.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

const claim = {
  idempotencyKey: 'run:test:commit',
  activityType: 'commitAndPush',
  inputHash: 'a'.repeat(64),
  ownerId: 'owner-1',
  leaseMs: 30_000,
} as const;

describe.skipIf(!hasDatabase)('AR-9 Postgres activity idempotency', () => {
  let handle: TestDatabase;

  beforeAll(async () => {
    handle = await setUpTestDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await handle.truncateAll();
  });

  it('atomically owns one live claim, rejects changed input, and replays a completed result', async () => {
    const repository = createActivityIdempotencyRepository(handle.db);
    const [left, right] = await Promise.all([
      repository.claim(claim),
      repository.claim({ ...claim, ownerId: 'owner-2' }),
    ]);
    expect([left.status, right.status].sort()).toEqual(['acquired', 'in_progress']);

    await expect(
      repository.claim({ ...claim, inputHash: 'b'.repeat(64), ownerId: 'owner-3' }),
    ).resolves.toEqual({ status: 'conflict' });

    const owner = left.status === 'acquired' ? claim.ownerId : 'owner-2';
    await expect(
      repository.complete({
        idempotencyKey: claim.idempotencyKey,
        ownerId: owner,
        resultHash: 'c'.repeat(64),
        result: { commitSha: 'd'.repeat(40) },
      }),
    ).resolves.toBe(true);
    await expect(repository.claim({ ...claim, ownerId: 'owner-4' })).resolves.toEqual({
      status: 'replay',
      resultHash: 'c'.repeat(64),
      result: { commitSha: 'd'.repeat(40) },
    });
  });

  it('recovers only an expired claim and fences the previous owner', async () => {
    const repository = createActivityIdempotencyRepository(handle.db);
    await expect(repository.claim(claim)).resolves.toEqual({ status: 'acquired' });
    await handle.db
      .update(activityIdempotency)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(sql`${activityIdempotency.idempotencyKey} = ${claim.idempotencyKey}`);

    await expect(repository.claim({ ...claim, ownerId: 'owner-2' })).resolves.toEqual({
      status: 'acquired',
    });
    await expect(
      repository.complete({
        idempotencyKey: claim.idempotencyKey,
        ownerId: claim.ownerId,
        resultHash: 'c'.repeat(64),
        result: { stale: true },
      }),
    ).resolves.toBe(false);
    await expect(
      repository.renew({
        idempotencyKey: claim.idempotencyKey,
        ownerId: 'owner-2',
        leaseMs: 30_000,
      }),
    ).resolves.toBe(true);
  });
});
