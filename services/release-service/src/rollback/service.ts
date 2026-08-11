import { createHash } from 'node:crypto';

import {
  CommitShaSchema,
  DeploymentHandleSchema,
  HttpsUrlSchema,
  idSchema,
  newId,
} from '@zapp/contracts';
import { MigrationReversibilitySchema } from '@zapp/verification-engine';
import { z } from 'zod';

import { ProductionHealthResultSchema } from '../release/health.js';

const OperationKeySchema = z.string().trim().min(8).max(400);
const ActivityKeySchema = z.string().trim().min(8).max(512);
const EnvironmentConfigVersionSchema = z.string().trim().min(1).max(512);
export const RollbackDatabaseStateSchema = z.enum([
  'compatible',
  'requires_compensation',
  'incompatible',
]);
export type RollbackDatabaseState = z.infer<typeof RollbackDatabaseStateSchema>;

export const RollbackRequestSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    toDeploymentId: idSchema('dep').optional(),
    reason: z.string().trim().min(1).max(2_000),
    operationKey: OperationKeySchema,
  })
  .strict();
export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;

const RollbackDeploymentSnapshotSchema = z
  .object({
    deploymentId: idSchema('dep'),
    releaseId: idSchema('rel'),
    commitSha: CommitShaSchema,
    providerId: z.string().trim().min(1).max(128),
    providerDeploymentId: z.string().trim().min(1).max(2_048),
    environmentConfigVersion: EnvironmentConfigVersionSchema,
    permanentUrl: HttpsUrlSchema,
  })
  .strict();

const CompensatingPlanSchema = z
  .object({
    planId: z.string().trim().min(1).max(256),
    approvalRecordId: z.string().trim().min(1).max(256),
    approved: z.boolean(),
    evidenceArtifactId: idSchema('art'),
  })
  .strict();

const RollbackContextSchema = z
  .object({
    current: RollbackDeploymentSnapshotSchema,
    target: RollbackDeploymentSnapshotSchema,
    migration: z
      .object({
        reversibility: MigrationReversibilitySchema,
        compensatingPlan: CompensatingPlanSchema.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((context, refinement) => {
    if (context.current.deploymentId === context.target.deploymentId) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target', 'deploymentId'],
        message: 'rollback_target_is_current_deployment',
      });
    }
    if (context.current.providerId !== context.target.providerId) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target', 'providerId'],
        message: 'rollback_provider_mismatch',
      });
    }
  });
type RollbackContext = z.infer<typeof RollbackContextSchema>;

export const RollbackResultSchema = z
  .object({
    deploymentId: idSchema('dep'),
    rollbackOfDeploymentId: idSchema('dep'),
    releaseId: idSchema('rel'),
    commitSha: CommitShaSchema,
    environmentConfigVersion: EnvironmentConfigVersionSchema,
    databaseState: z.enum(['compatible', 'requires_compensation']),
    compensatingPlanApplied: z.boolean(),
    status: z.literal('healthy'),
    healthEvidenceArtifactId: idSchema('art'),
  })
  .strict();
export type RollbackResult = z.infer<typeof RollbackResultSchema>;

const ReplayLookupInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    operationKey: OperationKeySchema,
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
type ReplayLookupInput = z.infer<typeof ReplayLookupInputSchema>;

const CreateRollbackDeploymentInputSchema = z
  .object({
    idempotencyKey: ActivityKeySchema,
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    deploymentId: idSchema('dep'),
    releaseId: idSchema('rel'),
    commitSha: CommitShaSchema,
    providerId: z.string().trim().min(1).max(128),
    environmentConfigVersion: EnvironmentConfigVersionSchema,
    rollbackOfDeploymentId: idSchema('dep'),
    targetProviderDeploymentId: z.string().trim().min(1).max(2_048),
    status: z.literal('queued'),
  })
  .strict();
type CreateRollbackDeploymentInput = z.infer<typeof CreateRollbackDeploymentInputSchema>;
const CreatedRollbackDeploymentSchema = z.object({ deploymentId: idSchema('dep') }).strict();

const RestoreEnvironmentConfigInputSchema = z
  .object({
    idempotencyKey: ActivityKeySchema,
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    deploymentId: idSchema('dep'),
    version: EnvironmentConfigVersionSchema,
  })
  .strict();
type RestoreEnvironmentConfigInput = z.infer<typeof RestoreEnvironmentConfigInputSchema>;
const RestoredEnvironmentConfigSchema = z
  .object({ version: EnvironmentConfigVersionSchema })
  .strict();

const ApplyCompensationInputSchema = z
  .object({
    idempotencyKey: ActivityKeySchema,
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    deploymentId: idSchema('dep'),
    planId: z.string().trim().min(1).max(256),
    approvalRecordId: z.string().trim().min(1).max(256),
    evidenceArtifactId: idSchema('art'),
  })
  .strict();
type ApplyCompensationInput = z.infer<typeof ApplyCompensationInputSchema>;
const AppliedCompensationSchema = ApplyCompensationInputSchema.pick({
  planId: true,
  approvalRecordId: true,
  evidenceArtifactId: true,
})
  .extend({ applied: z.literal(true) })
  .strict();

const ProviderRollbackInputSchema = z
  .object({
    idempotencyKey: ActivityKeySchema,
    providerId: z.string().trim().min(1).max(128),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    toProviderDeploymentId: z.string().trim().min(1).max(2_048),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();
type ProviderRollbackInput = z.infer<typeof ProviderRollbackInputSchema>;

const RollbackHealthInputSchema = z
  .object({
    idempotencyKey: ActivityKeySchema,
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    releaseId: idSchema('rel'),
    deploymentId: idSchema('dep'),
    providerDeploymentId: z.string().trim().min(1).max(2_048),
    previousHealthyDeploymentId: idSchema('dep'),
    productionUrl: HttpsUrlSchema,
    commitSha: CommitShaSchema,
  })
  .strict();
type RollbackHealthInput = z.infer<typeof RollbackHealthInputSchema>;
const RollbackHealthResultSchema = ProductionHealthResultSchema.extend({
  automaticRollbackAttempted: z.literal(false),
}).strict();

const MarkHealthyInputSchema = z
  .object({
    idempotencyKey: ActivityKeySchema,
    organizationId: idSchema('org'),
    deploymentId: idSchema('dep'),
    providerDeploymentId: z.string().trim().min(1).max(2_048),
    permanentUrl: HttpsUrlSchema,
    healthEvidenceArtifactId: idSchema('art'),
  })
  .strict();
type MarkHealthyInput = z.infer<typeof MarkHealthyInputSchema>;

const MarkFailedInputSchema = z
  .object({
    idempotencyKey: ActivityKeySchema,
    organizationId: idSchema('org'),
    deploymentId: idSchema('dep'),
    reason: z.enum([
      'compensating_plan_failed',
      'environment_config_restore_failed',
      'provider_rollback_failed',
      'rollback_health_failed',
      'rollback_recovery_failed',
    ]),
    healthEvidenceArtifactId: idSchema('art').optional(),
  })
  .strict();
type MarkFailedInput = z.infer<typeof MarkFailedInputSchema>;

const CompleteReplayInputSchema = ReplayLookupInputSchema.extend({
  result: RollbackResultSchema,
}).strict();
type CompleteReplayInput = z.infer<typeof CompleteReplayInputSchema>;

export interface RollbackDependencies {
  readonly context: {
    /** Tenant-scoped read of current/target deployment rows and immutable release evidence. */
    resolve(input: {
      readonly organizationId: string;
      readonly projectId: string;
      readonly environmentId: string;
      readonly toDeploymentId?: string;
    }): Promise<unknown>;
  };
  readonly store: {
    getReplay(input: ReplayLookupInput): Promise<unknown>;
    createRollback(input: CreateRollbackDeploymentInput): Promise<unknown>;
    markHealthy(input: MarkHealthyInput): Promise<void>;
    markFailed(input: MarkFailedInput): Promise<void>;
    completeReplay(input: CompleteReplayInput): Promise<void>;
  };
  readonly environmentConfig: {
    restore(input: RestoreEnvironmentConfigInput): Promise<unknown>;
  };
  readonly compensation: {
    apply(input: ApplyCompensationInput): Promise<unknown>;
  };
  readonly provider: {
    /** Keyed executor around the provider registry's `rollback` method. */
    rollback(input: ProviderRollbackInput): Promise<unknown>;
  };
  readonly health: {
    /** DEP-7 adapter with automatic rollback disabled; this service owns recovery. */
    verify(input: RollbackHealthInput): Promise<unknown>;
  };
  readonly newDeploymentId?: () => string;
}

export type RollbackServiceErrorCode =
  | 'compensating_plan_failed'
  | 'compensating_plan_required'
  | 'database_incompatible'
  | 'environment_config_restore_failed'
  | 'rollback_context_invalid'
  | 'rollback_health_failed'
  | 'rollback_not_found'
  | 'rollback_provider_failed'
  | 'rollback_recovery_failed'
  | 'rollback_store_failed';

export class RollbackServiceError extends Error {
  constructor(
    readonly code: RollbackServiceErrorCode,
    readonly statusCode: number,
    readonly databaseState: RollbackDatabaseState | null,
    message: string,
  ) {
    super(message);
    this.name = 'RollbackServiceError';
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function activityKey(input: RollbackRequest, suffix: string): string {
  return ActivityKeySchema.parse(`${input.operationKey}:${suffix}`);
}

function databaseState(context: RollbackContext): RollbackDatabaseState {
  switch (context.migration.reversibility) {
    case 'reversible':
      return 'compatible';
    case 'compensating':
      return 'requires_compensation';
    case 'unavailable':
      return 'incompatible';
  }
}

function assertDatabaseRollbackAllowed(context: RollbackContext): RollbackDatabaseState {
  const state = databaseState(context);
  if (state === 'incompatible') {
    throw new RollbackServiceError(
      'database_incompatible',
      422,
      state,
      'Rollback is blocked because release evidence does not prove database compatibility.',
    );
  }
  if (
    state === 'requires_compensation' &&
    (context.migration.compensatingPlan === null || !context.migration.compensatingPlan.approved)
  ) {
    throw new RollbackServiceError(
      'compensating_plan_required',
      422,
      state,
      'Rollback requires an approved compensating database plan attached to release evidence.',
    );
  }
  return state;
}

async function resolveContext(
  dependencies: RollbackDependencies,
  input: RollbackRequest,
): Promise<RollbackContext> {
  let value: unknown;
  try {
    value = await dependencies.context.resolve({
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      ...(input.toDeploymentId === undefined ? {} : { toDeploymentId: input.toDeploymentId }),
    });
  } catch {
    throw new RollbackServiceError(
      'rollback_context_invalid',
      500,
      null,
      'Rollback context resolution failed.',
    );
  }
  if (value === undefined) {
    throw new RollbackServiceError(
      'rollback_not_found',
      404,
      null,
      'Rollback source or target was not found.',
    );
  }
  try {
    const context = RollbackContextSchema.parse(value);
    if (
      input.toDeploymentId !== undefined &&
      context.target.deploymentId !== input.toDeploymentId
    ) {
      throw new Error('rollback_target_resolution_mismatch');
    }
    return context;
  } catch {
    throw new RollbackServiceError(
      'rollback_context_invalid',
      500,
      null,
      'Rollback context is invalid.',
    );
  }
}

async function markFailed(
  dependencies: RollbackDependencies,
  input: RollbackRequest,
  deploymentId: string,
  reason: MarkFailedInput['reason'],
  evidenceArtifactId?: string,
): Promise<void> {
  try {
    await dependencies.store.markFailed(
      MarkFailedInputSchema.parse({
        idempotencyKey: activityKey(input, `deployment:failed:${reason}`),
        organizationId: input.organizationId,
        deploymentId,
        reason,
        ...(evidenceArtifactId === undefined
          ? {}
          : { healthEvidenceArtifactId: evidenceArtifactId }),
      }),
    );
  } catch {
    throw new RollbackServiceError(
      'rollback_store_failed',
      500,
      null,
      'Failed rollback state could not be recorded.',
    );
  }
}

async function restoreConfig(
  dependencies: RollbackDependencies,
  input: RollbackRequest,
  deploymentId: string,
  version: string,
  suffix: string,
): Promise<void> {
  const restored = RestoredEnvironmentConfigSchema.parse(
    await dependencies.environmentConfig.restore(
      RestoreEnvironmentConfigInputSchema.parse({
        idempotencyKey: activityKey(input, suffix),
        organizationId: input.organizationId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        deploymentId,
        version,
      }),
    ),
  );
  if (restored.version !== version) {
    throw new Error('environment_config_version_mismatch');
  }
}

async function switchProvider(
  dependencies: RollbackDependencies,
  input: RollbackRequest,
  providerId: string,
  targetProviderDeploymentId: string,
  suffix: string,
): Promise<z.infer<typeof DeploymentHandleSchema>> {
  const handle = DeploymentHandleSchema.parse(
    await dependencies.provider.rollback(
      ProviderRollbackInputSchema.parse({
        idempotencyKey: activityKey(input, suffix),
        providerId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        toProviderDeploymentId: targetProviderDeploymentId,
        reason: input.reason,
      }),
    ),
  );
  if (handle.providerId !== providerId || handle.state !== 'ready') {
    throw new Error('provider_rollback_not_ready');
  }
  return handle;
}

export function createRollbackService(dependencies: RollbackDependencies): {
  rollback(input: RollbackRequest): Promise<RollbackResult>;
} {
  const newDeploymentId = dependencies.newDeploymentId ?? (() => newId('dep'));

  return {
    async rollback(inputValue) {
      const input = RollbackRequestSchema.parse(inputValue);
      const fingerprint = hash(input);
      const replayLookup = ReplayLookupInputSchema.parse({
        organizationId: input.organizationId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        operationKey: input.operationKey,
        fingerprint,
      });
      let replay: unknown;
      try {
        replay = await dependencies.store.getReplay(replayLookup);
        if (replay !== undefined) return RollbackResultSchema.parse(replay);
      } catch {
        throw new RollbackServiceError(
          'rollback_store_failed',
          500,
          null,
          'Rollback replay state could not be read.',
        );
      }

      const context = await resolveContext(dependencies, input);
      const state = assertDatabaseRollbackAllowed(context);
      let rollbackDeploymentId = idSchema('dep').parse(newDeploymentId());
      try {
        const created = CreatedRollbackDeploymentSchema.parse(
          await dependencies.store.createRollback(
            CreateRollbackDeploymentInputSchema.parse({
              idempotencyKey: activityKey(input, 'deployment:create'),
              organizationId: input.organizationId,
              projectId: input.projectId,
              environmentId: input.environmentId,
              deploymentId: rollbackDeploymentId,
              releaseId: context.target.releaseId,
              commitSha: context.target.commitSha,
              providerId: context.target.providerId,
              environmentConfigVersion: context.target.environmentConfigVersion,
              rollbackOfDeploymentId: context.current.deploymentId,
              targetProviderDeploymentId: context.target.providerDeploymentId,
              status: 'queued',
            }),
          ),
        );
        // On a retry after the row was created but before replay completion, the
        // keyed store returns the original row identity. Every later activity
        // must continue with that identity rather than a newly generated one.
        rollbackDeploymentId = created.deploymentId;
      } catch {
        throw new RollbackServiceError(
          'rollback_store_failed',
          500,
          state,
          'Rollback deployment could not be recorded.',
        );
      }

      try {
        await restoreConfig(
          dependencies,
          input,
          rollbackDeploymentId,
          context.target.environmentConfigVersion,
          'environment_config:target',
        );
      } catch {
        await markFailed(
          dependencies,
          input,
          rollbackDeploymentId,
          'environment_config_restore_failed',
        );
        throw new RollbackServiceError(
          'environment_config_restore_failed',
          502,
          state,
          'The previous environment configuration could not be restored.',
        );
      }

      let compensatingPlanApplied = false;
      const plan = context.migration.compensatingPlan;
      if (state === 'requires_compensation' && plan !== null) {
        try {
          const result = AppliedCompensationSchema.parse(
            await dependencies.compensation.apply(
              ApplyCompensationInputSchema.parse({
                idempotencyKey: activityKey(input, 'database:compensate'),
                organizationId: input.organizationId,
                projectId: input.projectId,
                environmentId: input.environmentId,
                deploymentId: rollbackDeploymentId,
                planId: plan.planId,
                approvalRecordId: plan.approvalRecordId,
                evidenceArtifactId: plan.evidenceArtifactId,
              }),
            ),
          );
          if (
            result.planId !== plan.planId ||
            result.approvalRecordId !== plan.approvalRecordId ||
            result.evidenceArtifactId !== plan.evidenceArtifactId
          ) {
            throw new Error('compensating_plan_evidence_mismatch');
          }
          compensatingPlanApplied = true;
        } catch {
          try {
            await restoreConfig(
              dependencies,
              input,
              rollbackDeploymentId,
              context.current.environmentConfigVersion,
              'environment_config:recover_after_compensation_failure',
            );
          } catch {
            await markFailed(dependencies, input, rollbackDeploymentId, 'rollback_recovery_failed');
            throw new RollbackServiceError(
              'rollback_recovery_failed',
              502,
              state,
              'The compensating plan failed and the current environment configuration could not be restored.',
            );
          }
          await markFailed(dependencies, input, rollbackDeploymentId, 'compensating_plan_failed');
          throw new RollbackServiceError(
            'compensating_plan_failed',
            502,
            state,
            'The approved compensating database plan failed.',
          );
        }
      }

      let providerHandle: z.infer<typeof DeploymentHandleSchema>;
      try {
        providerHandle = await switchProvider(
          dependencies,
          input,
          context.target.providerId,
          context.target.providerDeploymentId,
          'provider:target',
        );
      } catch {
        try {
          await restoreConfig(
            dependencies,
            input,
            rollbackDeploymentId,
            context.current.environmentConfigVersion,
            'environment_config:recover_after_provider_failure',
          );
        } catch {
          await markFailed(dependencies, input, rollbackDeploymentId, 'rollback_recovery_failed');
          throw new RollbackServiceError(
            'rollback_recovery_failed',
            502,
            state,
            'The provider rollback failed and the current environment configuration could not be restored.',
          );
        }
        await markFailed(dependencies, input, rollbackDeploymentId, 'provider_rollback_failed');
        throw new RollbackServiceError(
          'rollback_provider_failed',
          502,
          state,
          'The deployment provider could not switch to the rollback target.',
        );
      }

      let health: z.infer<typeof RollbackHealthResultSchema>;
      try {
        health = RollbackHealthResultSchema.parse(
          await dependencies.health.verify(
            RollbackHealthInputSchema.parse({
              idempotencyKey: activityKey(input, 'health:verify'),
              organizationId: input.organizationId,
              projectId: input.projectId,
              environmentId: input.environmentId,
              releaseId: context.target.releaseId,
              deploymentId: rollbackDeploymentId,
              providerDeploymentId: providerHandle.providerDeploymentId,
              previousHealthyDeploymentId: context.current.deploymentId,
              productionUrl: context.target.permanentUrl,
              commitSha: context.target.commitSha,
            }),
          ),
        );
      } catch {
        try {
          await switchProvider(
            dependencies,
            input,
            context.current.providerId,
            context.current.providerDeploymentId,
            'provider:recover_current',
          );
          await restoreConfig(
            dependencies,
            input,
            rollbackDeploymentId,
            context.current.environmentConfigVersion,
            'environment_config:recover_current',
          );
        } catch {
          await markFailed(dependencies, input, rollbackDeploymentId, 'rollback_recovery_failed');
          throw new RollbackServiceError(
            'rollback_recovery_failed',
            502,
            state,
            'Rollback health failed and the formerly healthy deployment could not be restored.',
          );
        }
        await markFailed(dependencies, input, rollbackDeploymentId, 'rollback_health_failed');
        throw new RollbackServiceError(
          'rollback_health_failed',
          502,
          state,
          'Rollback health verification failed; the formerly healthy deployment was restored.',
        );
      }

      if (health.status === 'failed') {
        try {
          await switchProvider(
            dependencies,
            input,
            context.current.providerId,
            context.current.providerDeploymentId,
            'provider:recover_current',
          );
          await restoreConfig(
            dependencies,
            input,
            rollbackDeploymentId,
            context.current.environmentConfigVersion,
            'environment_config:recover_current',
          );
        } catch {
          await markFailed(
            dependencies,
            input,
            rollbackDeploymentId,
            'rollback_recovery_failed',
            health.evidenceArtifactId,
          );
          throw new RollbackServiceError(
            'rollback_recovery_failed',
            502,
            state,
            'Rollback health failed and the formerly healthy deployment could not be restored.',
          );
        }
        await markFailed(
          dependencies,
          input,
          rollbackDeploymentId,
          'rollback_health_failed',
          health.evidenceArtifactId,
        );
        throw new RollbackServiceError(
          'rollback_health_failed',
          502,
          state,
          'Rollback health verification failed; the formerly healthy deployment was restored.',
        );
      }

      try {
        await dependencies.store.markHealthy(
          MarkHealthyInputSchema.parse({
            idempotencyKey: activityKey(input, 'deployment:healthy'),
            organizationId: input.organizationId,
            deploymentId: rollbackDeploymentId,
            providerDeploymentId: providerHandle.providerDeploymentId,
            permanentUrl: context.target.permanentUrl,
            healthEvidenceArtifactId: health.evidenceArtifactId,
          }),
        );
      } catch {
        throw new RollbackServiceError(
          'rollback_store_failed',
          500,
          state,
          'Healthy rollback state could not be recorded.',
        );
      }

      const result = RollbackResultSchema.parse({
        deploymentId: rollbackDeploymentId,
        rollbackOfDeploymentId: context.current.deploymentId,
        releaseId: context.target.releaseId,
        commitSha: context.target.commitSha,
        environmentConfigVersion: context.target.environmentConfigVersion,
        databaseState: state,
        compensatingPlanApplied,
        status: 'healthy',
        healthEvidenceArtifactId: health.evidenceArtifactId,
      });
      try {
        await dependencies.store.completeReplay(
          CompleteReplayInputSchema.parse({ ...replayLookup, result }),
        );
      } catch {
        throw new RollbackServiceError(
          'rollback_store_failed',
          500,
          state,
          'Rollback replay state could not be recorded.',
        );
      }
      return result;
    },
  };
}
