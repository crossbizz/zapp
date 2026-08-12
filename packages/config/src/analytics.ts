import { RunModeSchema, SupportLevelSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

export const ANALYTICS_EVENT_NAMES = [
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
] as const;

export const AnalyticsEventNameSchema = z.enum(ANALYTICS_EVENT_NAMES);
export type AnalyticsEventName = z.infer<typeof AnalyticsEventNameSchema>;

const CommonCaptureShape = {
  eventId: z.string().trim().min(1).max(200),
  distinctId: z.string().trim().min(1).max(200),
} as const;
const OrganizationPropertiesSchema = z.object({ orgId: idSchema('org') }).strict();
const ProjectPropertiesSchema = OrganizationPropertiesSchema.extend({
  projectId: idSchema('proj'),
  supportLevel: SupportLevelSchema,
}).strict();
const RunPropertiesSchema = ProjectPropertiesSchema.extend({ mode: RunModeSchema }).strict();

function captureSchema<TEvent extends AnalyticsEventName, TProperties extends z.ZodTypeAny>(
  event: TEvent,
  properties: TProperties,
) {
  return z.object({
    ...CommonCaptureShape,
    event: z.literal(event),
    properties,
  }).strict();
}

export const AnalyticsCaptureInputSchema = z.discriminatedUnion('event', [
  captureSchema('signup', z.object({}).strict()),
  captureSchema('org_created', OrganizationPropertiesSchema),
  captureSchema('project_created', ProjectPropertiesSchema),
  captureSchema('run_started', RunPropertiesSchema),
  captureSchema('plan_approved', RunPropertiesSchema),
  captureSchema('first_preview_ready', RunPropertiesSchema),
  captureSchema('change_applied', RunPropertiesSchema),
  captureSchema('verification_passed', RunPropertiesSchema),
  captureSchema('verification_failed', RunPropertiesSchema),
  captureSchema('release_created', ProjectPropertiesSchema),
  captureSchema('deploy_succeeded', ProjectPropertiesSchema),
  captureSchema('deploy_failed', ProjectPropertiesSchema),
  captureSchema('rollback_executed', ProjectPropertiesSchema),
  captureSchema(
    'credits_exhausted',
    OrganizationPropertiesSchema.extend({
      projectId: idSchema('proj').optional(),
      mode: RunModeSchema.optional(),
      supportLevel: SupportLevelSchema.optional(),
    }).strict(),
  ),
]);
export type AnalyticsCaptureInput = z.infer<typeof AnalyticsCaptureInputSchema>;

export const POSTHOG_DASHBOARDS = {
  northStar: {
    title: 'Verified releases per active organization per month',
    metric: 'verified_releases_per_active_org_per_month',
    event: 'release_created',
    verificationEvent: 'verification_passed',
    groupType: 'organization',
    interval: 'month',
  },
  activation: {
    title: 'Activation funnel',
    groupType: 'organization',
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
    title: 'Verification and deployment reliability',
    events: [
      'verification_passed',
      'verification_failed',
      'deploy_succeeded',
      'deploy_failed',
    ],
    groupType: 'organization',
  },
} as const;

export interface ProductAnalyticsProvider {
  capture(input: {
    readonly distinctId: string;
    readonly event: AnalyticsEventName;
    readonly groups?: Readonly<Record<'organization', string>>;
    readonly properties: Readonly<Record<string, string>>;
  }): void | Promise<void>;
}

export interface ProductAnalytics {
  capture(input: AnalyticsCaptureInput): Promise<void>;
}

/**
 * The catalog schema is the privacy boundary. Provider payloads are built only
 * from its parsed clone, so prompts, code, emails, and arbitrary caller fields
 * cannot reach PostHog even when a caller defeats TypeScript at runtime.
 */
export function createProductAnalytics(provider: ProductAnalyticsProvider): ProductAnalytics {
  return {
    async capture(rawInput) {
      const input = AnalyticsCaptureInputSchema.parse(rawInput);
      const orgId = 'orgId' in input.properties ? input.properties.orgId : undefined;
      const properties: Record<string, string> = { $insert_id: input.eventId };
      for (const [name, value] of Object.entries(input.properties)) {
        if (typeof value === 'string') properties[name] = value;
      }
      try {
        await provider.capture({
          distinctId: input.distinctId,
          event: input.event,
          ...(orgId === undefined ? {} : { groups: { organization: orgId } }),
          properties,
        });
      } catch {
        // Product analytics is observational. Provider availability must never
        // change a user mutation or a workflow outcome.
      }
    },
  };
}
