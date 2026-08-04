import { sql } from 'drizzle-orm';

import type { Executor } from './client.js';
import { runEventCounters } from './schema/execution.js';

/**
 * Allocates the next `agent_events.sequence` for a run: 1 for the first event,
 * then strictly +1, with no gaps and no duplicates however many writers race.
 *
 * The whole allocation is one statement, so Postgres does the serialization:
 * concurrent callers collide on the primary key, wait for the winner, and then
 * apply their own `+1` to the row it left behind. A `SELECT max(sequence)` over
 * `agent_events` could not do this — two readers would see the same maximum —
 * and a Postgres sequence would leave gaps, which the PRD §14.4 replay contract
 * reads as lost events.
 *
 * Pass an open transaction as `tx` to allocate and insert atomically: an
 * allocation that is rolled back leaves the counter advanced, which is a gap.
 */
export async function nextEventSequence(tx: Executor, runId: string): Promise<number> {
  const [row] = await tx
    .insert(runEventCounters)
    .values({ runId, lastSequence: 1 })
    .onConflictDoUpdate({
      target: runEventCounters.runId,
      // Reads the *existing* row, not the proposed one: `excluded.last_sequence`
      // would be the constant 1 above and would hand out 1 forever.
      set: { lastSequence: sql`${runEventCounters.lastSequence} + 1` },
    })
    .returning({ lastSequence: runEventCounters.lastSequence });

  if (row === undefined) {
    // Unreachable: an upsert with RETURNING always yields the row it wrote.
    throw new Error(`failed to allocate an event sequence for run ${runId}`);
  }
  return row.lastSequence;
}
