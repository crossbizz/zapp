import { and, eq, gt, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { activityIdempotency } from './schema/execution.js';

export interface ActivityIdempotencyClaimInput {
  readonly idempotencyKey: string;
  readonly activityType: string;
  readonly inputHash: string;
  readonly ownerId: string;
  readonly leaseMs: number;
}

export type ActivityIdempotencyClaim =
  | { readonly status: 'acquired' }
  | { readonly status: 'in_progress' }
  | { readonly status: 'conflict' }
  | {
      readonly status: 'replay';
      readonly resultHash: string;
      readonly result: unknown;
    };

export interface ActivityIdempotencyRepository {
  claim(input: ActivityIdempotencyClaimInput): Promise<ActivityIdempotencyClaim>;
  renew(input: {
    readonly idempotencyKey: string;
    readonly ownerId: string;
    readonly leaseMs: number;
  }): Promise<boolean>;
  complete(input: {
    readonly idempotencyKey: string;
    readonly ownerId: string;
    readonly resultHash: string;
    readonly result: unknown;
  }): Promise<boolean>;
  release(input: {
    readonly idempotencyKey: string;
    readonly ownerId: string;
  }): Promise<void>;
}

const leaseUntil = (leaseMs: number) =>
  sql`clock_timestamp() + (${leaseMs} * interval '1 millisecond')`;

/** Atomic Postgres claim/replay store used by the Temporal activity interceptor. */
export function createActivityIdempotencyRepository(
  db: Database,
): ActivityIdempotencyRepository {
  return {
    claim(input) {
      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(activityIdempotency)
          .values({
            idempotencyKey: input.idempotencyKey,
            activityType: input.activityType,
            inputHash: input.inputHash,
            status: 'running',
            ownerId: input.ownerId,
            leaseExpiresAt: leaseUntil(input.leaseMs),
          })
          .onConflictDoNothing()
          .returning({ idempotencyKey: activityIdempotency.idempotencyKey });
        if (inserted.length === 1) return { status: 'acquired' };

        const rows = await tx
          .select({
            activityType: activityIdempotency.activityType,
            inputHash: activityIdempotency.inputHash,
            status: activityIdempotency.status,
            resultHash: activityIdempotency.resultHash,
            result: activityIdempotency.resultJson,
            expired: sql<boolean>`${activityIdempotency.leaseExpiresAt} <= clock_timestamp()`,
          })
          .from(activityIdempotency)
          .where(eq(activityIdempotency.idempotencyKey, input.idempotencyKey))
          .for('update');
        const row = rows[0];
        if (row === undefined) throw new Error('Activity idempotency claim disappeared');
        if (row.activityType !== input.activityType || row.inputHash !== input.inputHash) {
          return { status: 'conflict' };
        }
        if (row.status === 'completed') {
          if (row.resultHash === null) throw new Error('Completed activity result hash is missing');
          return { status: 'replay', resultHash: row.resultHash, result: row.result };
        }
        if (!row.expired) return { status: 'in_progress' };
        await tx
          .update(activityIdempotency)
          .set({
            ownerId: input.ownerId,
            leaseExpiresAt: leaseUntil(input.leaseMs),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(activityIdempotency.idempotencyKey, input.idempotencyKey));
        return { status: 'acquired' };
      });
    },

    async renew(input) {
      const rows = await db
        .update(activityIdempotency)
        .set({
          leaseExpiresAt: leaseUntil(input.leaseMs),
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(activityIdempotency.idempotencyKey, input.idempotencyKey),
            eq(activityIdempotency.status, 'running'),
            eq(activityIdempotency.ownerId, input.ownerId),
            gt(activityIdempotency.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning({ idempotencyKey: activityIdempotency.idempotencyKey });
      return rows.length === 1;
    },

    async complete(input) {
      const rows = await db
        .update(activityIdempotency)
        .set({
          status: 'completed',
          ownerId: null,
          leaseExpiresAt: null,
          resultHash: input.resultHash,
          resultJson: input.result,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(activityIdempotency.idempotencyKey, input.idempotencyKey),
            eq(activityIdempotency.status, 'running'),
            eq(activityIdempotency.ownerId, input.ownerId),
            gt(activityIdempotency.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning({ idempotencyKey: activityIdempotency.idempotencyKey });
      return rows.length === 1;
    },

    async release(input) {
      await db.delete(activityIdempotency).where(
        and(
          eq(activityIdempotency.idempotencyKey, input.idempotencyKey),
          eq(activityIdempotency.status, 'running'),
          eq(activityIdempotency.ownerId, input.ownerId),
        ),
      );
    },
  };
}
