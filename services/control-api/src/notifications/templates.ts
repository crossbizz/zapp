import { z } from 'zod';

import type { NotificationTrigger } from './service.js';

export const RenderedNotificationSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    text: z.string().trim().min(1).max(20_000),
    webUrl: z.string().url(),
    desktopUrl: z.string().url(),
  })
  .strict();

export type RenderedNotification = z.infer<typeof RenderedNotificationSchema>;

const COPY = {
  approval_requested: ['Approval requested', 'A run is waiting for your approval.'],
  run_completed: ['Run completed', 'A zapp.build run completed successfully.'],
  run_failed: ['Run failed', 'A zapp.build run needs attention.'],
  budget_50: ['Run budget at 50%', 'A run has used 50% of its approved budget.'],
  budget_80: ['Run budget at 80%', 'A run has used 80% of its approved budget.'],
  budget_100: ['Run budget exhausted', 'A run has used 100% of its approved budget.'],
  synthetic_check_failed: ['Production check failed', 'A production synthetic check failed.'],
  production_incident: [
    'Production incident detected',
    'Open the incident to review evidence and create a Fix run.',
  ],
  deploy_succeeded: ['Deployment succeeded', 'A production deployment completed successfully.'],
  deploy_failed: ['Deployment failed', 'A production deployment needs attention.'],
  payment_failed: ['Payment failed', 'A subscription payment failed.'],
  member_invited: ['You were invited to zapp.build', 'You were invited to join an organization.'],
} as const satisfies Readonly<Record<NotificationTrigger['type'], readonly [string, string]>>;

function destination(
  trigger: NotificationTrigger,
  webBaseUrl: URL,
): {
  readonly webUrl: string;
  readonly desktopUrl: string;
} {
  if (trigger.type === 'member_invited' && typeof trigger.context['inviteUrl'] === 'string') {
    return {
      webUrl: new URL(trigger.context['inviteUrl']).toString(),
      desktopUrl: `zapp://invites/${encodeURIComponent(trigger.triggerId)}`,
    };
  }
  if (
    trigger.type === 'production_incident' &&
    trigger.projectId !== undefined &&
    typeof trigger.context['incidentId'] === 'string'
  ) {
    const projectId = encodeURIComponent(trigger.projectId);
    const incidentId = encodeURIComponent(trigger.context['incidentId']);
    return {
      webUrl: new URL(`/projects/${projectId}?incident=${incidentId}`, webBaseUrl).toString(),
      desktopUrl: `zapp://projects/${projectId}/incidents/${incidentId}`,
    };
  }
  const parts = ['organizations', trigger.organizationId];
  if (trigger.projectId !== undefined) parts.push('projects', trigger.projectId);
  if (trigger.runId !== undefined) parts.push('runs', trigger.runId);
  const path = parts.map(encodeURIComponent).join('/');
  return {
    webUrl: new URL(`/${path}`, webBaseUrl).toString(),
    desktopUrl: `zapp://${path}`,
  };
}

export function renderNotification(
  trigger: NotificationTrigger,
  webBaseUrl: URL,
): RenderedNotification {
  const [subject, summary] = COPY[trigger.type];
  const links = destination(trigger, webBaseUrl);
  return RenderedNotificationSchema.parse({
    subject,
    text: `${summary}\n\nOpen in browser: ${links.webUrl}\nOpen in desktop: ${links.desktopUrl}`,
    ...links,
  });
}
