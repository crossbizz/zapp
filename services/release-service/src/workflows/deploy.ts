import { proxyActivities } from '@temporalio/workflow';
import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

export const DEPLOYMENT_STAGES = [
  'readiness_check',
  'build_artifact',
  'configure_secrets',
  'apply_migrations',
  'provision_runtime',
  'start_services',
  'production_health_check',
  'go_live',
] as const;

export const DeploymentStageSchema = z.enum(DEPLOYMENT_STAGES);
export type DeploymentStage = z.infer<typeof DeploymentStageSchema>;

const OperationKeySchema = z.string().trim().min(8).max(400);
const ActivityIdempotencyKeySchema = z.string().trim().min(8).max(512);
export const DeployMigrationPlanSchema = z
  .object({
    planId: z.string().trim().min(1).max(255),
    validationEvidenceArtifactId: idSchema('art'),
    destructive: z.boolean(),
    approvalRecordId: z.string().trim().min(1).max(255).nullable(),
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.destructive && plan.approvalRecordId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvalRecordId'],
        message: 'destructive_migration_approval_required',
      });
    }
  });
export type DeployMigrationPlan = z.infer<typeof DeployMigrationPlanSchema>;

export const DeployWorkflowInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    releaseId: idSchema('rel'),
    deploymentId: idSchema('dep'),
    operationKey: OperationKeySchema,
    migrationPlan: DeployMigrationPlanSchema.nullable(),
  })
  .strict();
export type DeployWorkflowInput = z.infer<typeof DeployWorkflowInputSchema>;

export const DeploymentUpdatedPayloadSchema = z
  .object({
    stage: DeploymentStageSchema,
    status: z.enum(['running', 'passed', 'failed']),
    elapsedMs: z.number().int().nonnegative(),
    summary: z.string().trim().min(1).max(500),
    evidenceArtifactId: idSchema('art').optional(),
  })
  .strict();
export type DeploymentUpdatedPayload = z.infer<typeof DeploymentUpdatedPayloadSchema>;

const DeploymentStageResultSchema = z
  .object({
    summary: z.string().trim().min(1).max(500),
    evidenceArtifactId: idSchema('art').optional(),
  })
  .strict();

const MigrationPlanVerificationSchema = z
  .object({
    planId: z.string().trim().min(1).max(255),
    preApproved: z.boolean(),
    destructive: z.boolean(),
    approvalRecordId: z.string().trim().min(1).max(255).nullable(),
    destructiveApprovalVerified: z.boolean(),
  })
  .strict();

const DeploymentStatusSchema = z.enum(['queued', 'deploying', 'healthy', 'failed']);

const DeploymentActivityContextSchema = DeployWorkflowInputSchema.pick({
  organizationId: true,
  projectId: true,
  environmentId: true,
  releaseId: true,
  deploymentId: true,
}).strict();
type DeploymentActivityContext = z.infer<typeof DeploymentActivityContextSchema>;

const KeyedDeploymentActivitySchema = DeploymentActivityContextSchema.extend({
  idempotencyKey: ActivityIdempotencyKeySchema,
}).strict();

export const TransitionDeploymentStatusActivityInputSchema = KeyedDeploymentActivitySchema.extend({
  from: DeploymentStatusSchema,
  to: DeploymentStatusSchema,
}).strict();
export type TransitionDeploymentStatusActivityInput = z.infer<
  typeof TransitionDeploymentStatusActivityInputSchema
>;

export const EmitDeploymentUpdatedActivityInputSchema = KeyedDeploymentActivitySchema.extend({
  type: z.literal('deployment.updated'),
  payload: DeploymentUpdatedPayloadSchema,
}).strict();
export type EmitDeploymentUpdatedActivityInput = z.infer<
  typeof EmitDeploymentUpdatedActivityInputSchema
>;

export const VerifyMigrationPlanActivityInputSchema = KeyedDeploymentActivitySchema.extend({
  plan: DeployMigrationPlanSchema,
}).strict();
export type VerifyMigrationPlanActivityInput = z.infer<
  typeof VerifyMigrationPlanActivityInputSchema
>;

export const ExecuteDeploymentStageActivityInputSchema = KeyedDeploymentActivitySchema.extend({
  stage: DeploymentStageSchema,
  migrationPlan: DeployMigrationPlanSchema.nullable(),
}).strict();
export type ExecuteDeploymentStageActivityInput = z.infer<
  typeof ExecuteDeploymentStageActivityInputSchema
>;

export interface DeployWorkflowActivities {
  transitionDeploymentStatus(input: TransitionDeploymentStatusActivityInput): Promise<void>;
  emitDeploymentUpdated(input: EmitDeploymentUpdatedActivityInput): Promise<void>;
  verifyMigrationPlan(input: VerifyMigrationPlanActivityInput): Promise<unknown>;
  executeDeploymentStage(input: ExecuteDeploymentStageActivityInput): Promise<unknown>;
}

export const DeployWorkflowResultSchema = z
  .object({ deploymentId: idSchema('dep'), status: z.literal('healthy') })
  .strict();
export type DeployWorkflowResult = z.infer<typeof DeployWorkflowResultSchema>;

const STAGE_TITLES: Readonly<Record<DeploymentStage, string>> = {
  readiness_check: 'Readiness check',
  build_artifact: 'Build artifact',
  configure_secrets: 'Configure secrets',
  apply_migrations: 'Apply migrations',
  provision_runtime: 'Provision runtime',
  start_services: 'Start services',
  production_health_check: 'Production health check',
  go_live: 'Go live',
};

function activityContext(input: DeployWorkflowInput): DeploymentActivityContext {
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    releaseId: input.releaseId,
    deploymentId: input.deploymentId,
  };
}

function key(input: DeployWorkflowInput, suffix: string): string {
  return ActivityIdempotencyKeySchema.parse(`${input.operationKey}:${suffix}`);
}

async function assertMigrationPlanStillApproved(
  input: DeployWorkflowInput,
  activities: DeployWorkflowActivities,
): Promise<void> {
  const plan = input.migrationPlan;
  if (plan === null) return;
  const verification = MigrationPlanVerificationSchema.parse(
    await activities.verifyMigrationPlan(
      VerifyMigrationPlanActivityInputSchema.parse({
        ...activityContext(input),
        idempotencyKey: key(input, 'apply_migrations:approval'),
        plan,
      }),
    ),
  );
  if (verification.planId !== plan.planId) {
    throw new Error('migration_plan_approval_mismatch');
  }
  if (!verification.preApproved) {
    throw new Error('migration_plan_not_preapproved');
  }
  if (verification.destructive !== plan.destructive) {
    throw new Error('migration_plan_destructive_classification_changed');
  }
  if (plan.destructive && verification.approvalRecordId !== plan.approvalRecordId) {
    throw new Error('destructive_migration_approval_record_mismatch');
  }
  if (plan.destructive && !verification.destructiveApprovalVerified) {
    throw new Error('destructive_migration_approval_not_verified');
  }
}

async function emit(
  input: DeployWorkflowInput,
  activities: DeployWorkflowActivities,
  payload: DeploymentUpdatedPayload,
): Promise<void> {
  await activities.emitDeploymentUpdated(
    EmitDeploymentUpdatedActivityInputSchema.parse({
      ...activityContext(input),
      idempotencyKey: key(input, `${payload.stage}:event:${payload.status}`),
      type: 'deployment.updated',
      payload: DeploymentUpdatedPayloadSchema.parse(payload),
    }),
  );
}

/** Deterministic workflow body, split from Temporal proxy construction for focused testing. */
export async function executeDeployWorkflow(
  rawInput: DeployWorkflowInput,
  activities: DeployWorkflowActivities,
  nowMs: () => number = Date.now,
): Promise<DeployWorkflowResult> {
  const input = DeployWorkflowInputSchema.parse(rawInput);
  const context = activityContext(input);
  await activities.transitionDeploymentStatus(
    TransitionDeploymentStatusActivityInputSchema.parse({
      ...context,
      idempotencyKey: key(input, 'deployment:deploying'),
      from: 'queued',
      to: 'deploying',
    }),
  );

  for (const stage of DEPLOYMENT_STAGES) {
    const startedAt = nowMs();
    await emit(input, activities, {
      stage,
      status: 'running',
      elapsedMs: 0,
      summary: `${STAGE_TITLES[stage]} started.`,
    });
    let result: z.infer<typeof DeploymentStageResultSchema>;
    try {
      if (stage === 'apply_migrations') {
        await assertMigrationPlanStillApproved(input, activities);
      }
      result = DeploymentStageResultSchema.parse(
        await activities.executeDeploymentStage(
          ExecuteDeploymentStageActivityInputSchema.parse({
            ...context,
            idempotencyKey: key(input, `${stage}:execute`),
            stage,
            migrationPlan: input.migrationPlan,
          }),
        ),
      );
    } catch (error) {
      const elapsedMs = Math.max(0, nowMs() - startedAt);
      await activities.transitionDeploymentStatus(
        TransitionDeploymentStatusActivityInputSchema.parse({
          ...context,
          idempotencyKey: key(input, 'deployment:failed'),
          from: 'deploying',
          to: 'failed',
        }),
      );
      await emit(input, activities, {
        stage,
        status: 'failed',
        elapsedMs,
        summary: `${STAGE_TITLES[stage]} failed.`,
      });
      throw error;
    }
    const elapsedMs = Math.max(0, nowMs() - startedAt);
    await emit(input, activities, {
      stage,
      status: 'passed',
      elapsedMs,
      summary: result.summary,
      ...(result.evidenceArtifactId === undefined
        ? {}
        : { evidenceArtifactId: result.evidenceArtifactId }),
    });
  }

  await activities.transitionDeploymentStatus(
    TransitionDeploymentStatusActivityInputSchema.parse({
      ...context,
      idempotencyKey: key(input, 'deployment:healthy'),
      from: 'deploying',
      to: 'healthy',
    }),
  );
  return DeployWorkflowResultSchema.parse({
    deploymentId: input.deploymentId,
    status: 'healthy',
  });
}

/** Temporal entry point for the release worker's `releases` task queue. */
export async function deployWorkflow(input: DeployWorkflowInput): Promise<DeployWorkflowResult> {
  const activities = proxyActivities<DeployWorkflowActivities>({
    startToCloseTimeout: '30 minutes',
    retry: { maximumAttempts: 3 },
  });
  return executeDeployWorkflow(input, activities);
}
