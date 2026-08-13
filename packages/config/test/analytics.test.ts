import { describe, expect, it, vi } from 'vitest';

import {
  ANALYTICS_EVENT_NAMES,
  AnalyticsCaptureInputSchema,
  POSTHOG_DASHBOARDS,
  createProductAnalytics,
} from '../src/analytics.js';

const ORGANIZATION_ID = 'org_01J00000000000000000000000';
const PROJECT_ID = 'proj_01J00000000000000000000000';

describe('typed product analytics', () => {
  it('publishes the binding event and dashboard catalogs', () => {
    expect(ANALYTICS_EVENT_NAMES).toEqual([
      'signup',
      'org_created',
      'project_created',
      'run_started',
      'plan_approved',
      'first_preview_ready',
      'change_applied',
      'verification_passed',
      'verification_failed',
      'release_created',
      'deploy_succeeded',
      'deploy_failed',
      'rollback_executed',
      'credits_exhausted',
    ]);
    expect(POSTHOG_DASHBOARDS).toMatchObject({
      northStar: {
        metric: 'verified_releases_per_active_org_per_month',
        groupType: 'organization',
      },
      activation: {
        steps: [
          'signup',
          'org_created',
          'project_created',
          'run_started',
          'first_preview_ready',
          'verification_passed',
          'release_created',
          'deploy_succeeded',
        ],
      },
      reliability: {
        events: ['verification_passed', 'verification_failed', 'deploy_succeeded', 'deploy_failed'],
      },
    });
  });

  it('rejects prompt and code content at the typed boundary', () => {
    const base = {
      eventId: 'run:one:started',
      distinctId: 'user_01J00000000000000000000000',
      event: 'run_started',
      properties: {
        orgId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        mode: 'build',
        supportLevel: 'managed',
      },
    } as const;
    expect(AnalyticsCaptureInputSchema.safeParse(base).success).toBe(true);
    expect(AnalyticsCaptureInputSchema.safeParse({
      ...base,
      properties: { ...base.properties, prompt: 'secret customer request' },
    }).success).toBe(false);
    expect(AnalyticsCaptureInputSchema.safeParse({
      ...base,
      properties: { ...base.properties, code: 'export const secret = true' },
    }).success).toBe(false);
  });

  it('captures organization-scoped events with a stable insert id and never blocks on outage', async () => {
    const capture = vi.fn(() => {
      throw new Error('PostHog unavailable');
    });
    const analytics = createProductAnalytics({ capture });

    await expect(analytics.capture({
      eventId: 'run:one:started',
      distinctId: 'user_01J00000000000000000000000',
      event: 'run_started',
      properties: {
        orgId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        mode: 'build',
        supportLevel: 'managed',
      },
    })).resolves.toBeUndefined();

    expect(capture).toHaveBeenCalledWith({
      distinctId: 'user_01J00000000000000000000000',
      event: 'run_started',
      groups: { organization: ORGANIZATION_ID },
      properties: {
        $insert_id: 'run:one:started',
        orgId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        mode: 'build',
        supportLevel: 'managed',
      },
    });
  });
});
