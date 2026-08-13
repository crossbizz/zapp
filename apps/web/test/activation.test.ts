import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { RunEvent } from '@zapp/api-client';
import { newId } from '@zapp/contracts';

import {
  ACTIVATION_EVENTS,
  activationFromRunEvent,
  emitActivation,
  type ActivationAnalyticsPort,
} from '../src/lib/activation.js';

function event(type: RunEvent['data']['type'], payload: Record<string, unknown> = {}): RunEvent {
  const data: RunEvent['data'] = {
    id: newId('evt'),
    organizationId: newId('org'),
    projectId: newId('proj'),
    runId: newId('run'),
    sequence: 1,
    occurredAt: '2026-08-12T12:00:00.000Z',
    type,
    visibility: 'user',
    payload,
  };
  return { id: String(data.sequence), type: data.type, data };
}

void describe('WEB-16 activation funnel', () => {
  void it('keeps the binding funnel names exact', () => {
    assert.deepEqual(ACTIVATION_EVENTS, [
      'signup',
      'project_created',
      'first_preview_ready',
      'first_change_applied',
      'plan_approved',
      'first_deploy_succeeded',
    ]);
  });

  void it('projects only structural run events and decisions', () => {
    assert.equal(activationFromRunEvent(event('preview.ready')), 'first_preview_ready');
    assert.equal(activationFromRunEvent(event('commit.created')), 'first_change_applied');
    assert.equal(
      activationFromRunEvent(
        event('approval.resolved', { decision: 'approved', gate: 'build_plan' }),
      ),
      'plan_approved',
    );
    assert.equal(
      activationFromRunEvent(event('deployment.updated', { stage: 'go_live', status: 'passed' })),
      'first_deploy_succeeded',
    );
    assert.equal(
      activationFromRunEvent(event('approval.resolved', { decision: 'rejected', gate: 'plan' })),
      undefined,
    );
    assert.equal(
      activationFromRunEvent(
        event('deployment.updated', { stage: 'build_artifact', status: 'passed' }),
      ),
      undefined,
    );
  });

  void it('groups by organization, sends no event payload, and deduplicates first milestones', () => {
    const captured: { readonly event: string; readonly properties: Record<string, unknown> }[] = [];
    const groups: string[] = [];
    const values = new Map<string, string>();
    const analytics: ActivationAnalyticsPort = {
      group(_type, organizationId) {
        groups.push(organizationId);
      },
      capture(name, properties) {
        captured.push({ event: name, properties });
      },
    };
    const storage = {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    };
    const ready = event('preview.ready', { prompt: 'must not leave the event stream' });

    emitActivation(
      {
        event: 'first_preview_ready',
        eventId: ready.data.id,
        organizationId: ready.data.organizationId,
        projectId: ready.data.projectId,
        runId: ready.data.runId,
      },
      analytics,
      storage,
    );
    emitActivation(
      {
        event: 'first_preview_ready',
        eventId: newId('evt'),
        organizationId: ready.data.organizationId,
        projectId: ready.data.projectId,
        runId: ready.data.runId,
      },
      analytics,
      storage,
    );

    assert.deepEqual(groups, [ready.data.organizationId]);
    assert.deepEqual(captured, [
      {
        event: 'first_preview_ready',
        properties: {
          $groups: { organization: ready.data.organizationId },
          $insert_id: ready.data.id,
          organization_id: ready.data.organizationId,
          project_id: ready.data.projectId,
          run_id: ready.data.runId,
        },
      },
    ]);
  });
});
