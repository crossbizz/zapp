import {
  AnalyticsCaptureInputSchema,
  type AnalyticsCaptureInput,
} from '@zapp/config';
import type { AgentEvent, RunMode, SupportLevel } from '@zapp/contracts';

export interface AgentEventAnalyticsContext {
  readonly mode: RunMode;
  readonly supportLevel: SupportLevel;
  readonly isFirstPreview: boolean;
}

type ProjectedEvent = Pick<
  AgentEvent,
  'id' | 'runId' | 'organizationId' | 'projectId' | 'type' | 'payload'
>;

/**
 * Converts the immutable operational event stream to the small analytics
 * catalog. It intentionally does not spread the event payload: prompts, code,
 * model output, tool arguments and arbitrary future fields have no path into
 * the provider payload.
 */
export function projectAgentEvent(
  event: ProjectedEvent,
  context: AgentEventAnalyticsContext,
): AnalyticsCaptureInput | undefined {
  let projected: AnalyticsCaptureInput['event'] | undefined;
  switch (event.type) {
    case 'run.started':
      projected = 'run_started';
      break;
    case 'approval.resolved':
      projected =
        event.payload['decision'] === 'approved' &&
        (event.payload['gate'] === 'plan' || event.payload['gate'] === 'build_plan')
          ? 'plan_approved'
          : undefined;
      break;
    case 'preview.ready':
      projected = context.isFirstPreview ? 'first_preview_ready' : undefined;
      break;
    case 'commit.created':
      projected = 'change_applied';
      break;
    case 'verification.completed':
      projected =
        event.payload['decision'] === 'approved'
          ? 'verification_passed'
          : 'verification_failed';
      break;
    case 'release.created':
      projected = 'release_created';
      break;
    case 'deployment.updated':
      projected =
        event.payload['status'] === 'failed'
          ? 'deploy_failed'
          : event.payload['stage'] === 'go_live' && event.payload['status'] === 'passed'
            ? 'deploy_succeeded'
            : undefined;
      break;
    case 'approval.requested':
      projected =
        event.payload['reason'] === 'organization_credit_exhausted'
          ? 'credits_exhausted'
          : undefined;
      break;
    default:
      projected = undefined;
  }
  if (projected === undefined) return undefined;

  const projectProperties = {
    orgId: event.organizationId,
    projectId: event.projectId,
    supportLevel: context.supportLevel,
  };
  const properties =
    projected === 'release_created' ||
    projected === 'deploy_succeeded' ||
    projected === 'deploy_failed'
      ? projectProperties
      : { ...projectProperties, mode: context.mode };

  return AnalyticsCaptureInputSchema.parse({
    eventId:
      projected === 'release_created' && typeof event.payload['releaseId'] === 'string'
        ? `release_created:${event.payload['releaseId']}`
        : event.id,
    distinctId: event.runId,
    event: projected,
    properties,
  });
}
