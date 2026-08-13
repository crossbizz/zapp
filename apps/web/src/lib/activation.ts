'use client';

import type { RunEvent } from '@zapp/api-client';
import posthog from 'posthog-js';

export const ACTIVATION_EVENTS = [
  'signup',
  'project_created',
  'first_preview_ready',
  'first_change_applied',
  'plan_approved',
  'first_deploy_succeeded',
] as const;

export type ActivationEvent = (typeof ACTIVATION_EVENTS)[number];

export interface ActivationAnalyticsPort {
  group(type: 'organization', organizationId: string): void;
  capture(event: ActivationEvent, properties: Record<string, unknown>): void;
}

interface ActivationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ActivationInput {
  readonly event: ActivationEvent;
  readonly eventId: string;
  readonly organizationId: string;
  readonly projectId?: string;
  readonly runId?: string;
}

const firstOrganizationMilestones = new Set<ActivationEvent>([
  'first_preview_ready',
  'first_change_applied',
  'first_deploy_succeeded',
]);

export function activationFromRunEvent(event: RunEvent): ActivationEvent | undefined {
  switch (event.data.type) {
    case 'preview.ready':
      return 'first_preview_ready';
    case 'commit.created':
      return 'first_change_applied';
    case 'approval.resolved':
      return event.data.payload['decision'] === 'approved' &&
        (event.data.payload['gate'] === 'plan' || event.data.payload['gate'] === 'build_plan')
        ? 'plan_approved'
        : undefined;
    case 'deployment.updated':
      return event.data.payload['stage'] === 'go_live' && event.data.payload['status'] === 'passed'
        ? 'first_deploy_succeeded'
        : undefined;
    default:
      return undefined;
  }
}

function deduplicationKey(input: ActivationInput): string {
  const identity = firstOrganizationMilestones.has(input.event) ? 'first' : input.eventId;
  return `zapp:activation:${input.organizationId}:${input.event}:${identity}`;
}

export function emitActivation(
  input: ActivationInput,
  analytics: ActivationAnalyticsPort,
  storage: ActivationStorage,
): void {
  const key = deduplicationKey(input);
  try {
    if (storage.getItem(key) !== null) return;
    storage.setItem(key, input.eventId);
  } catch {
    // Browser storage is only the duplicate guard; analytics remains observational.
  }
  try {
    analytics.group('organization', input.organizationId);
    analytics.capture(input.event, {
      $groups: { organization: input.organizationId },
      $insert_id: input.eventId,
      organization_id: input.organizationId,
      ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
      ...(input.runId === undefined ? {} : { run_id: input.runId }),
    });
  } catch {
    // Product analytics must never alter a user-visible workflow outcome.
  }
}

function browserAnalyticsReady(organizationId: string): boolean {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (key === undefined || key.length === 0) return false;
  if (!posthog.__loaded) {
    const configuredHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
    posthog.init(key, {
      api_host:
        configuredHost === undefined || configuredHost.length === 0
          ? 'https://us.i.posthog.com'
          : configuredHost,
      capture_pageleave: false,
      capture_pageview: false,
      person_profiles: 'identified_only',
    });
  }
  posthog.group('organization', organizationId);
  return true;
}

export function captureRunActivation(event: RunEvent): void {
  const activation = activationFromRunEvent(event);
  if (activation === undefined || !browserAnalyticsReady(event.data.organizationId)) return;
  emitActivation(
    {
      event: activation,
      eventId: event.data.id,
      organizationId: event.data.organizationId,
      projectId: event.data.projectId,
      runId: event.data.runId,
    },
    posthog,
    localStorage,
  );
}

export function captureProjectCreated(input: {
  readonly organizationId: string;
  readonly projectId: string;
}): void {
  if (!browserAnalyticsReady(input.organizationId)) return;
  emitActivation(
    {
      event: 'project_created',
      eventId: `project_created:${input.projectId}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
    },
    posthog,
    localStorage,
  );
}

export function captureSignup(input: {
  readonly organizationId: string;
  readonly userId: string;
}): void {
  if (!browserAnalyticsReady(input.organizationId)) return;
  emitActivation(
    {
      event: 'signup',
      eventId: `signup:${input.userId}`,
      organizationId: input.organizationId,
    },
    posthog,
    localStorage,
  );
}
