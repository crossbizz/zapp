import {
  createFeatureFlagEvaluator,
  createProductAnalytics,
  type FeatureFlagProvider,
  type ProductAnalyticsProvider,
} from '@zapp/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPostHogAdapters } from '../src/analytics/posthog.js';
import { projectAgentEvent } from '../src/analytics/events.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import { buildHarness, signIn, type Harness } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const OWNER = {
  externalId: 'analytics-owner',
  email: 'analytics-owner@zapp.test',
  displayName: 'Analytics Owner',
} as const;

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.app.close()));
});

describe('PostHog adapters', () => {
  it('uses the organization group for server event capture and flag evaluation', async () => {
    const getFlag = vi.fn().mockReturnValue(true);
    const client = {
      capture: vi.fn(),
      evaluateFlags: vi.fn().mockResolvedValue({ getFlag }),
    };
    const adapters = createPostHogAdapters(client);
    const analytics = createProductAnalytics(adapters.analytics);
    const flags = createFeatureFlagEvaluator({ provider: adapters.flags });

    await analytics.capture({
      eventId: 'evt_signup_1',
      distinctId: 'user_00000000000000000000000001',
      event: 'org_created',
      properties: { orgId: 'org_00000000000000000000000001' },
    });
    await flags.evaluate('autonomous-mode', {
      organizationId: 'org_00000000000000000000000001',
      distinctId: 'user_00000000000000000000000001',
    });

    expect(client.capture).toHaveBeenCalledWith({
      distinctId: 'user_00000000000000000000000001',
      event: 'org_created',
      groups: { organization: 'org_00000000000000000000000001' },
      properties: {
        $insert_id: 'evt_signup_1',
        orgId: 'org_00000000000000000000000001',
      },
    });
    expect(client.evaluateFlags).toHaveBeenCalledWith(
      'user_00000000000000000000000001',
      {
        flagKeys: ['autonomous-mode'],
        groups: { organization: 'org_00000000000000000000000001' },
      },
    );
    expect(getFlag).toHaveBeenCalledWith('autonomous-mode');
  });
});

describe('agent event analytics projection', () => {
  const base = {
    id: 'evt_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
    runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
    sequence: 1,
    occurredAt: '2026-08-11T00:00:00.000Z',
    organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
    projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
    visibility: 'user' as const,
  };
  const context = {
    mode: 'autonomous' as const,
    supportLevel: 'managed' as const,
    isFirstPreview: true,
  };

  it('maps only catalogued lifecycle facts and cannot forward prompt or code payloads', () => {
    const captured = projectAgentEvent(
      {
        ...base,
        type: 'approval.resolved',
        payload: {
          gate: 'plan',
          decision: 'approved',
          prompt: 'private prompt',
          code: 'secret source',
        },
      },
      context,
    );

    expect(captured).toEqual({
      eventId: base.id,
      distinctId: base.runId,
      event: 'plan_approved',
      properties: {
        orgId: base.organizationId,
        projectId: base.projectId,
        mode: 'autonomous',
        supportLevel: 'managed',
      },
    });
    expect(JSON.stringify(captured)).not.toContain('private prompt');
    expect(JSON.stringify(captured)).not.toContain('secret source');
    expect(
      projectAgentEvent(
        { ...base, type: 'message.user', payload: { content: 'private prompt' } },
        context,
      ),
    ).toBeUndefined();
  });

  it.each([
    ['run.started', { mode: 'autonomous' }, 'run_started'],
    ['preview.ready', { action: 'start' }, 'first_preview_ready'],
    ['commit.created', { commitSha: 'abc' }, 'change_applied'],
    ['verification.completed', { decision: 'approved' }, 'verification_passed'],
    ['verification.completed', { decision: 'needs_human' }, 'verification_failed'],
    ['release.created', { releaseId: 'rel_01K00000000000000000000001' }, 'release_created'],
    ['deployment.updated', { stage: 'go_live', status: 'passed' }, 'deploy_succeeded'],
    ['deployment.updated', { stage: 'build_artifact', status: 'failed' }, 'deploy_failed'],
    ['approval.requested', { reason: 'organization_credit_exhausted' }, 'credits_exhausted'],
  ] as const)('maps %s to %s', (type, payload, expected) => {
    expect(projectAgentEvent({ ...base, type, payload }, context)?.event).toBe(expected);
  });

  it('emits the first preview only', () => {
    expect(
      projectAgentEvent(
        { ...base, type: 'preview.ready', payload: { action: 'restart' } },
        { ...context, isFirstPreview: false },
      ),
    ).toBeUndefined();
  });

  it('deduplicates workflow and API release captures by release id', () => {
    expect(
      projectAgentEvent(
        {
          ...base,
          type: 'release.created',
          payload: { releaseId: 'rel_01K00000000000000000000001' },
        },
        context,
      )?.eventId,
    ).toBe('release_created:rel_01K00000000000000000000001');
  });
});

describe('GET /v1/feature-flags', () => {
  it('returns only client flags after evaluating them in the caller organization', async () => {
    const evaluate = vi.fn<FeatureFlagProvider['evaluate']>(({ flag }) =>
      Promise.resolve(flag === 'mobile-app-tab'),
    );
    const provider: FeatureFlagProvider = {
      evaluate,
    };
    const built = buildHarness({
      tenantDb: new InMemoryTenantData().factory,
      featureFlags: createFeatureFlagEvaluator({ provider }),
    });
    harnesses.push(built);
    const owner = await signIn(built, OWNER);
    const organization = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Analytics Organization' },
    });
    expect(organization.statusCode, organization.body).toBe(201);
    const organizationId = organization.json<{ organization: { id: string } }>().organization.id;

    const response = await built.app.inject({
      method: 'GET',
      url: '/v1/feature-flags',
      headers: { ...owner.headers, [ORGANIZATION_HEADER]: organizationId },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      flags: {
        'voice-input': false,
        'mobile-app-tab': true,
        'visual-editing': false,
      },
    });
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: owner.userId,
        groups: { organization: organizationId },
      }),
    );
  });
});

describe('public lifecycle analytics', () => {
  it('captures signup once plus organization and project creation without user content', async () => {
    const capture = vi.fn<ProductAnalyticsProvider['capture']>();
    const built = buildHarness({
      tenantDb: new InMemoryTenantData().factory,
      productAnalytics: createProductAnalytics({ capture }),
    });
    harnesses.push(built);
    const owner = await signIn(built, OWNER);
    await signIn(built, OWNER);

    const organization = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Private Customer Name' },
    });
    expect(organization.statusCode, organization.body).toBe(201);
    const organizationId = organization.json<{ organization: { id: string } }>().organization.id;
    const project = await built.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { ...owner.headers, [ORGANIZATION_HEADER]: organizationId },
      payload: { name: 'Private Project Name', sourceType: 'blank' },
    });
    expect(project.statusCode, project.body).toBe(201);
    const projectId = project.json<{ project: { id: string } }>().project.id;

    expect(capture.mock.calls.map(([event]) => event.event)).toEqual([
      'signup',
      'org_created',
      'project_created',
    ]);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'project_created',
        groups: { organization: organizationId },
        properties: {
          $insert_id: `project_created:${projectId}`,
          orgId: organizationId,
          projectId,
          supportLevel: 'compatible',
        },
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain('Private Customer Name');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('Private Project Name');
  });
});
