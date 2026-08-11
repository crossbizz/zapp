import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import { HttpsUrlSchema, SupportLevelSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

import { ProductionFlowSchema, selectProductionSafeFlows } from '../release/health.js';
import {
  SyntheticRunInputSchema,
  SyntheticRunResultSchema,
  type SyntheticRunInput,
  type SyntheticRunResult,
} from './runner.js';

export const DEFAULT_SYNTHETIC_CRON = '*/5 * * * *';

const OperationKeySchema = z.string().trim().min(8).max(400);
const ActivityKeySchema = z.string().trim().min(8).max(512);
const FlowRefSchema = z.string().trim().min(1).max(256);
const ScheduleIdSchema = z.string().trim().min(1).max(512);

export const ScheduleManagedReleaseInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    releaseId: idSchema('rel'),
    supportLevel: SupportLevelSchema,
    productionUrl: HttpsUrlSchema,
    operationKey: OperationKeySchema,
    criticalFlows: z.array(ProductionFlowSchema).max(1_000),
  })
  .strict()
  .superRefine((input, refinement) => {
    const ids = input.criticalFlows.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criticalFlows'],
        message: 'synthetic_duplicate_flow_ref',
      });
    }
  });
export type ScheduleManagedReleaseInput = z.infer<typeof ScheduleManagedReleaseInputSchema>;

const SyntheticCheckRowSchema = z
  .object({
    id: idSchema('syn'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    name: z.string().trim().min(1).max(256),
    schedule: z.literal(DEFAULT_SYNTHETIC_CRON),
    status: z.enum(['enabled', 'disabled', 'passing', 'failing']),
    lastRunAt: z.string().datetime().nullable(),
  })
  .strict();
const SyntheticCheckBindingSchema = z
  .object({
    releaseId: idSchema('rel'),
    flowRef: FlowRefSchema,
    productionUrl: HttpsUrlSchema,
  })
  .strict();
const ClaimSyntheticCheckInputSchema = z
  .object({
    idempotencyKey: ActivityKeySchema,
    fingerprint: z.string().min(1).max(300_000),
    row: SyntheticCheckRowSchema,
    binding: SyntheticCheckBindingSchema,
  })
  .strict();
type ClaimSyntheticCheckInput = z.infer<typeof ClaimSyntheticCheckInputSchema>;

const ClaimedSyntheticCheckSchema = z
  .object({ row: SyntheticCheckRowSchema, binding: SyntheticCheckBindingSchema })
  .strict();

export const SyntheticCheckWorkflowInputSchema = SyntheticCheckBindingSchema.extend({
  organizationId: idSchema('org'),
  projectId: idSchema('proj'),
  environmentId: idSchema('env'),
  syntheticCheckId: idSchema('syn'),
}).strict();
export type SyntheticCheckWorkflowInput = z.infer<typeof SyntheticCheckWorkflowInputSchema>;

const EnsureCronScheduleInputSchema = z
  .object({
    idempotencyKey: ActivityKeySchema,
    scheduleId: ScheduleIdSchema,
    cron: z.literal(DEFAULT_SYNTHETIC_CRON),
    overlapPolicy: z.literal('skip'),
    workflowInput: SyntheticCheckWorkflowInputSchema,
  })
  .strict();
type EnsureCronScheduleInput = z.infer<typeof EnsureCronScheduleInputSchema>;

const EnsureCronScheduleResultSchema = z.object({ scheduleId: ScheduleIdSchema }).strict();

export const ScheduledSyntheticCheckSchema = z
  .object({
    syntheticCheckId: idSchema('syn'),
    name: z.string().trim().min(1).max(256),
    schedule: z.literal(DEFAULT_SYNTHETIC_CRON),
    status: z.enum(['enabled', 'disabled', 'passing', 'failing']),
  })
  .strict();
export type ScheduledSyntheticCheck = z.infer<typeof ScheduledSyntheticCheckSchema>;

export interface SyntheticSchedulerDependencies {
  readonly store: { claim(input: ClaimSyntheticCheckInput): Promise<unknown> };
  readonly temporal: { ensureCronSchedule(input: EnsureCronScheduleInput): Promise<unknown> };
  readonly newSyntheticCheckId: () => string;
}

export interface SyntheticCheckWorkflowActivities {
  runSyntheticCheck(input: SyntheticRunInput): Promise<unknown>;
}

export class SyntheticSchedulerError extends Error {
  constructor(
    readonly code: 'synthetic_claim_invalid' | 'synthetic_schedule_invalid',
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'SyntheticSchedulerError';
  }
}

function normalizedUrl(value: string): string {
  return HttpsUrlSchema.parse(new URL(value).toString());
}

function fingerprint(
  input: ScheduleManagedReleaseInput,
  flow: z.infer<typeof ProductionFlowSchema>,
): string {
  return JSON.stringify({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    releaseId: input.releaseId,
    productionUrl: normalizedUrl(input.productionUrl),
    flow,
  });
}

function assertClaim(
  input: ScheduleManagedReleaseInput,
  flow: z.infer<typeof ProductionFlowSchema>,
  claimed: z.infer<typeof ClaimedSyntheticCheckSchema>,
): void {
  if (
    claimed.row.organizationId !== input.organizationId ||
    claimed.row.projectId !== input.projectId ||
    claimed.row.environmentId !== input.environmentId ||
    claimed.row.name !== flow.title ||
    claimed.binding.releaseId !== input.releaseId ||
    claimed.binding.flowRef !== flow.id ||
    normalizedUrl(claimed.binding.productionUrl) !== normalizedUrl(input.productionUrl)
  ) {
    throw new SyntheticSchedulerError(
      'synthetic_claim_invalid',
      500,
      'The synthetic check store returned a row for a different release or flow.',
    );
  }
}

export function createSyntheticScheduler(dependencies: SyntheticSchedulerDependencies): {
  scheduleManagedRelease(input: ScheduleManagedReleaseInput): Promise<ScheduledSyntheticCheck[]>;
} {
  return {
    async scheduleManagedRelease(inputValue) {
      const input = ScheduleManagedReleaseInputSchema.parse(inputValue);
      if (input.supportLevel !== 'managed') return [];

      const scheduled: ScheduledSyntheticCheck[] = [];
      const productionSafeFlows = selectProductionSafeFlows(input.criticalFlows);
      for (const [index, flow] of productionSafeFlows.entries()) {
        const proposedId = idSchema('syn').parse(dependencies.newSyntheticCheckId());
        const row = SyntheticCheckRowSchema.parse({
          id: proposedId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          name: flow.title,
          schedule: DEFAULT_SYNTHETIC_CRON,
          status: 'enabled',
          lastRunAt: null,
        });
        const binding = SyntheticCheckBindingSchema.parse({
          releaseId: input.releaseId,
          flowRef: flow.id,
          productionUrl: normalizedUrl(input.productionUrl),
        });
        const claimed = ClaimedSyntheticCheckSchema.parse(
          await dependencies.store.claim(
            ClaimSyntheticCheckInputSchema.parse({
              idempotencyKey: `${input.operationKey}:check:${index.toString()}`,
              fingerprint: fingerprint(input, flow),
              row,
              binding,
            }),
          ),
        );
        assertClaim(input, flow, claimed);

        const scheduleId = `synthetic:${claimed.row.id}`;
        const scheduleResult = EnsureCronScheduleResultSchema.parse(
          await dependencies.temporal.ensureCronSchedule(
            EnsureCronScheduleInputSchema.parse({
              idempotencyKey: `${input.operationKey}:schedule:${claimed.row.id}`,
              scheduleId,
              cron: claimed.row.schedule,
              overlapPolicy: 'skip',
              workflowInput: {
                organizationId: input.organizationId,
                projectId: input.projectId,
                environmentId: input.environmentId,
                releaseId: claimed.binding.releaseId,
                syntheticCheckId: claimed.row.id,
                flowRef: claimed.binding.flowRef,
                productionUrl: normalizedUrl(claimed.binding.productionUrl),
              },
            }),
          ),
        );
        if (scheduleResult.scheduleId !== scheduleId) {
          throw new SyntheticSchedulerError(
            'synthetic_schedule_invalid',
            500,
            'Temporal returned a different synthetic schedule identity.',
          );
        }
        scheduled.push(
          ScheduledSyntheticCheckSchema.parse({
            syntheticCheckId: claimed.row.id,
            name: claimed.row.name,
            schedule: claimed.row.schedule,
            status: claimed.row.status,
          }),
        );
      }
      return scheduled;
    },
  };
}

/** Deterministic workflow body kept separate for focused tests. */
export async function executeSyntheticCheckWorkflow(
  inputValue: SyntheticCheckWorkflowInput,
  activities: SyntheticCheckWorkflowActivities,
  executionIdValue: string,
): Promise<SyntheticRunResult> {
  const input = SyntheticCheckWorkflowInputSchema.parse(inputValue);
  const executionId = z.string().trim().min(1).max(256).parse(executionIdValue);
  return SyntheticRunResultSchema.parse(
    await activities.runSyntheticCheck(
      SyntheticRunInputSchema.parse({
        ...input,
        operationKey: `${input.syntheticCheckId}:${executionId}`,
      }),
    ),
  );
}

const syntheticActivities = proxyActivities<SyntheticCheckWorkflowActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3 },
});

export async function syntheticCheckWorkflow(
  input: SyntheticCheckWorkflowInput,
): Promise<SyntheticRunResult> {
  return await executeSyntheticCheckWorkflow(input, syntheticActivities, workflowInfo().runId);
}
