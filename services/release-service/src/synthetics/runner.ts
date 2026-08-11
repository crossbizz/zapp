import { HttpsUrlSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

export const SYNTHETIC_RESULT_RETENTION_DAYS = 30;

const OperationKeySchema = z.string().trim().min(8).max(400);
const ActivityKeySchema = z.string().trim().min(8).max(512);
const FlowRefSchema = z.string().trim().min(1).max(256);
const SummarySchema = z.string().trim().min(1).max(2_000);

export const SyntheticRunInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    releaseId: idSchema('rel'),
    syntheticCheckId: idSchema('syn'),
    flowRef: FlowRefSchema,
    productionUrl: HttpsUrlSchema,
    operationKey: OperationKeySchema,
  })
  .strict();
export type SyntheticRunInput = z.infer<typeof SyntheticRunInputSchema>;

const CompletedSyntheticRunResultSchema = z
  .object({
    syntheticCheckId: idSchema('syn'),
    status: z.enum(['passed', 'failed']),
    incidentCreated: z.boolean(),
    fixOffered: z.boolean(),
    evidenceArtifactIds: z.array(idSchema('art')).max(1_000),
    completedAt: z.string().datetime(),
  })
  .strict();

const DisabledSyntheticRunResultSchema = z
  .object({
    syntheticCheckId: idSchema('syn'),
    status: z.literal('disabled'),
    incidentCreated: z.literal(false),
    fixOffered: z.literal(false),
  })
  .strict();

export const SyntheticRunResultSchema = z.discriminatedUnion('status', [
  DisabledSyntheticRunResultSchema,
  CompletedSyntheticRunResultSchema,
]);
export type SyntheticRunResult = z.infer<typeof SyntheticRunResultSchema>;

const SyntheticContextSchema = z
  .object({
    status: z.enum(['enabled', 'disabled', 'passing', 'failing']),
    releaseId: idSchema('rel'),
    flowRef: FlowRefSchema,
    productionUrl: HttpsUrlSchema,
  })
  .strict();

const ReplayLookupSchema = SyntheticRunInputSchema.pick({
  organizationId: true,
  projectId: true,
  environmentId: true,
  releaseId: true,
  syntheticCheckId: true,
  operationKey: true,
})
  .extend({ fingerprint: z.string().min(1).max(10_000) })
  .strict();
type ReplayLookup = z.infer<typeof ReplayLookupSchema>;

const VerificationInputSchema = SyntheticRunInputSchema.omit({ operationKey: true })
  .extend({ idempotencyKey: ActivityKeySchema })
  .strict();
type VerificationInput = z.infer<typeof VerificationInputSchema>;

const VerificationResultSchema = z
  .object({
    status: z.enum(['passed', 'failed']),
    summary: SummarySchema,
    evidenceArtifactIds: z.array(idSchema('art')).max(1_000),
  })
  .strict()
  .superRefine((result, refinement) => {
    if (result.status === 'failed' && result.evidenceArtifactIds.length === 0) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceArtifactIds'],
        message: 'failed synthetic checks require immutable evidence',
      });
    }
  });

const RecordResultInputSchema = VerificationInputSchema.omit({ idempotencyKey: true })
  .extend({
    idempotencyKey: ActivityKeySchema,
    status: z.enum(['passed', 'failed']),
    summary: SummarySchema,
    evidenceArtifactIds: z.array(idSchema('art')).max(1_000),
    completedAt: z.string().datetime(),
    retainUntil: z.string().datetime(),
  })
  .strict();
type RecordResultInput = z.infer<typeof RecordResultInputSchema>;

const UpdateHealthInputSchema = SyntheticRunInputSchema.pick({
  organizationId: true,
  projectId: true,
  environmentId: true,
  syntheticCheckId: true,
})
  .extend({
    idempotencyKey: ActivityKeySchema,
    status: z.enum(['passing', 'failing']),
    lastRunAt: z.string().datetime(),
  })
  .strict();
type UpdateHealthInput = z.infer<typeof UpdateHealthInputSchema>;

const FailureActionInputSchema = SyntheticRunInputSchema.omit({ operationKey: true })
  .extend({
    idempotencyKey: ActivityKeySchema,
    evidenceArtifactIds: z.array(idSchema('art')).max(1_000),
    summary: SummarySchema,
  })
  .strict();

const IncidentInputSchema = FailureActionInputSchema.extend({
  type: z.literal('synthetic_check.failed'),
}).strict();
type IncidentInput = z.infer<typeof IncidentInputSchema>;

const NotificationInputSchema = FailureActionInputSchema.extend({
  type: z.literal('synthetic_check_failed'),
}).strict();
type NotificationInput = z.infer<typeof NotificationInputSchema>;

const FixOfferInputSchema = FailureActionInputSchema.extend({
  source: z.literal('failed_check'),
  reproductionRef: z.string().trim().min(1).max(4_096),
}).strict();
type FixOfferInput = z.infer<typeof FixOfferInputSchema>;

const CompleteReplayInputSchema = ReplayLookupSchema.extend({
  result: CompletedSyntheticRunResultSchema,
}).strict();
type CompleteReplayInput = z.infer<typeof CompleteReplayInputSchema>;

export interface SyntheticRunnerDependencies {
  readonly context: {
    /** Tenant-scoped row plus immutable Temporal binding resolution. */
    resolve(input: Omit<SyntheticRunInput, 'operationKey'>): Promise<unknown>;
  };
  readonly store: {
    getReplay(input: ReplayLookup): Promise<unknown>;
    recordResult(input: RecordResultInput): Promise<void>;
    updateHealth(input: UpdateHealthInput): Promise<void>;
    completeReplay(input: CompleteReplayInput): Promise<void>;
  };
  readonly verification: {
    /** Verification-service activity with its tool allowlist fixed to read-only production steps. */
    runProductionSafeFlow(input: VerificationInput): Promise<unknown>;
  };
  readonly incident: { emit(input: IncidentInput): Promise<void> };
  readonly notifications: { send(input: NotificationInput): Promise<void> };
  readonly fixes: {
    /** Creates an AR-19 user action, never an autonomous production mutation. */
    offer(input: FixOfferInput): Promise<void>;
  };
  readonly now?: () => Date;
}

export class SyntheticRunnerError extends Error {
  constructor(
    readonly code: 'synthetic_context_invalid' | 'synthetic_replay_invalid',
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'SyntheticRunnerError';
  }
}

function normalizedUrl(value: string): string {
  return HttpsUrlSchema.parse(new URL(value).toString());
}

function activityKey(input: SyntheticRunInput, suffix: string): string {
  return ActivityKeySchema.parse(`${input.operationKey}:${suffix}`);
}

function fingerprint(input: SyntheticRunInput): string {
  return JSON.stringify({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    releaseId: input.releaseId,
    syntheticCheckId: input.syntheticCheckId,
    flowRef: input.flowRef,
    productionUrl: normalizedUrl(input.productionUrl),
  });
}

function contextInput(input: SyntheticRunInput): Omit<SyntheticRunInput, 'operationKey'> {
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    releaseId: input.releaseId,
    syntheticCheckId: input.syntheticCheckId,
    flowRef: input.flowRef,
    productionUrl: normalizedUrl(input.productionUrl),
  };
}

function assertContext(
  input: SyntheticRunInput,
  context: z.infer<typeof SyntheticContextSchema>,
): void {
  if (
    context.releaseId !== input.releaseId ||
    context.flowRef !== input.flowRef ||
    normalizedUrl(context.productionUrl) !== normalizedUrl(input.productionUrl)
  ) {
    throw new SyntheticRunnerError(
      'synthetic_context_invalid',
      500,
      'The synthetic check binding does not match the scheduled release and flow.',
    );
  }
}

function replayLookup(input: SyntheticRunInput): ReplayLookup {
  return ReplayLookupSchema.parse({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    releaseId: input.releaseId,
    syntheticCheckId: input.syntheticCheckId,
    operationKey: input.operationKey,
    fingerprint: fingerprint(input),
  });
}

function retainUntil(completedAt: Date): string {
  return new Date(
    completedAt.getTime() + SYNTHETIC_RESULT_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
}

export function createSyntheticRunner(dependencies: SyntheticRunnerDependencies): {
  run(input: SyntheticRunInput): Promise<SyntheticRunResult>;
} {
  const now = dependencies.now ?? (() => new Date());
  return {
    async run(inputValue) {
      const input = SyntheticRunInputSchema.parse(inputValue);
      const context = SyntheticContextSchema.parse(
        await dependencies.context.resolve(contextInput(input)),
      );
      assertContext(input, context);
      if (context.status === 'disabled') {
        return DisabledSyntheticRunResultSchema.parse({
          syntheticCheckId: input.syntheticCheckId,
          status: 'disabled',
          incidentCreated: false,
          fixOffered: false,
        });
      }

      const lookup = replayLookup(input);
      const replayValue = await dependencies.store.getReplay(lookup);
      if (replayValue !== undefined && replayValue !== null) {
        const replay = CompletedSyntheticRunResultSchema.safeParse(replayValue);
        if (!replay.success || replay.data.syntheticCheckId !== input.syntheticCheckId) {
          throw new SyntheticRunnerError(
            'synthetic_replay_invalid',
            500,
            'The synthetic check store returned an invalid replay.',
          );
        }
        return replay.data;
      }

      const verificationInput = VerificationInputSchema.parse({
        ...contextInput(input),
        idempotencyKey: activityKey(input, 'verify'),
      });
      const verification = VerificationResultSchema.parse(
        await dependencies.verification.runProductionSafeFlow(verificationInput),
      );
      const completed = now();
      const completedAt = completed.toISOString();
      await dependencies.store.recordResult(
        RecordResultInputSchema.parse({
          ...verificationInput,
          idempotencyKey: activityKey(input, 'result'),
          ...verification,
          completedAt,
          retainUntil: retainUntil(completed),
        }),
      );
      await dependencies.store.updateHealth(
        UpdateHealthInputSchema.parse({
          organizationId: input.organizationId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          syntheticCheckId: input.syntheticCheckId,
          idempotencyKey: activityKey(input, 'health'),
          status: verification.status === 'passed' ? 'passing' : 'failing',
          lastRunAt: completedAt,
        }),
      );

      const failed = verification.status === 'failed';
      if (failed) {
        const failureContext = {
          ...contextInput(input),
          evidenceArtifactIds: verification.evidenceArtifactIds,
          summary: verification.summary,
        };
        await dependencies.incident.emit(
          IncidentInputSchema.parse({
            ...failureContext,
            idempotencyKey: activityKey(input, 'incident'),
            type: 'synthetic_check.failed',
          }),
        );
        await dependencies.notifications.send(
          NotificationInputSchema.parse({
            ...failureContext,
            idempotencyKey: activityKey(input, 'notification'),
            type: 'synthetic_check_failed',
          }),
        );
        await dependencies.fixes.offer(
          FixOfferInputSchema.parse({
            ...failureContext,
            idempotencyKey: activityKey(input, 'fix_offer'),
            source: 'failed_check',
            reproductionRef: `synthetic:${input.syntheticCheckId}:${input.operationKey}`,
          }),
        );
      }

      const result = CompletedSyntheticRunResultSchema.parse({
        syntheticCheckId: input.syntheticCheckId,
        status: verification.status,
        incidentCreated: failed,
        fixOffered: failed,
        evidenceArtifactIds: verification.evidenceArtifactIds,
        completedAt,
      });
      await dependencies.store.completeReplay(
        CompleteReplayInputSchema.parse({ ...lookup, result }),
      );
      return result;
    },
  };
}
