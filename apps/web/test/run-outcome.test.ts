import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunEvent } from '@zapp/api-client';

import { failedRunOutcome, runCompletedSuccessfully } from '../src/components/run-outcome';

function event(payload: Record<string, unknown>): RunEvent {
  return {
    id: 'evt_01J00000000000000000000000',
    type: 'run.completed',
    data: {
      runId: 'run_01J00000000000000000000000',
      organizationId: 'org_01J00000000000000000000000',
      projectId: 'proj_01J00000000000000000000000',
      occurredAt: '2026-08-16T00:00:00.000Z',
      payload,
      sequence: 9,
      visibility: 'user',
    },
  } as RunEvent;
}

void test('projects a failed terminal run without treating it as successful completion', () => {
  const events = [
    event({
      status: 'failed',
      code: 'provider_error',
      summary: 'The model provider request failed after its retries.',
    }),
  ];

  assert.equal(runCompletedSuccessfully(events), false);
  assert.deepEqual(failedRunOutcome(events), {
    code: 'provider_error',
    summary: 'The model provider request failed after its retries.',
  });
});

void test('keeps successful and legacy terminal events compatible', () => {
  assert.equal(runCompletedSuccessfully([event({ status: 'completed' })]), true);
  assert.equal(runCompletedSuccessfully([event({})]), true);
  assert.equal(failedRunOutcome([event({ status: 'completed' })]), undefined);
});
