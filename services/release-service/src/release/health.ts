import { AppPathSchema, HttpsUrlSchema, SupportLevelSchema, idSchema } from '@zapp/contracts';
import { EvidenceManifestSchema } from '@zapp/verification-engine';
import { z } from 'zod';

export const PRODUCTION_HEALTH_ATTEMPTS = 3;
export const PRODUCTION_HEALTH_INTERVAL_MS = 10_000;
export const PRODUCTION_ERROR_RATE_WINDOW_MS = 120_000;

const OperationKeySchema = z.string().trim().min(8).max(400);
const ActivityKeySchema = z.string().trim().min(8).max(512);

export const ProductionFlowStepSchema = z
  .object({
    kind: z.enum([
      'navigate',
      'assert_visible',
      'assert_text',
      'read_text',
      'snapshot',
      'click',
      'fill',
      'submit',
      'upload',
      'delete',
    ]),
    value: z.string().trim().min(1).max(2_048),
  })
  .strict();

export const ProductionFlowSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    title: z.string().trim().min(1).max(256),
    critical: z.boolean(),
    tags: z.array(z.string().trim().min(1).max(64)).max(32),
    steps: z.array(ProductionFlowStepSchema).min(1).max(100),
  })
  .strict();
export type ProductionFlow = z.infer<typeof ProductionFlowSchema>;

export const ProductionHealthInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    releaseId: idSchema('rel'),
    deploymentId: idSchema('dep'),
    providerDeploymentId: z.string().trim().min(1).max(1_024),
    previousHealthyDeploymentId: idSchema('dep').nullable(),
    productionUrl: HttpsUrlSchema,
    healthPath: AppPathSchema,
    operationKey: OperationKeySchema,
    criticalFlows: z.array(ProductionFlowSchema).max(1_000),
  })
  .strict()
  .superRefine((input, context) => {
    const flowIds = input.criticalFlows.map(({ id }) => id);
    if (new Set(flowIds).size !== flowIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criticalFlows'],
        message: 'production_smoke_duplicate_flow',
      });
    }
  });
export type ProductionHealthInput = z.infer<typeof ProductionHealthInputSchema>;

const HealthAttemptSchema = z
  .object({
    statusCode: z.number().int().min(100).max(599).nullable(),
    evidenceArtifactId: idSchema('art').optional(),
  })
  .strict();

const HealthEndpointEvidenceSchema = z
  .object({
    status: z.enum(['passed', 'failed']),
    path: AppPathSchema,
    intervalMs: z.literal(PRODUCTION_HEALTH_INTERVAL_MS),
    attempts: z.array(HealthAttemptSchema).length(PRODUCTION_HEALTH_ATTEMPTS),
  })
  .strict();

const ErrorRateEvidenceSchema = z
  .object({
    status: z.enum(['passed', 'failed', 'not_run']),
    windowMs: z.literal(PRODUCTION_ERROR_RATE_WINDOW_MS),
    burstDetected: z.boolean().nullable(),
    evidenceArtifactIds: z.array(idSchema('art')).max(1_000),
  })
  .strict();

const SmokeFlowResultSchema = z
  .object({ flowId: z.string().trim().min(1).max(256), status: z.enum(['passed', 'failed']) })
  .strict();

const ProductionSmokeEvidenceSchema = z
  .object({
    status: z.enum(['passed', 'failed', 'not_run', 'not_applicable']),
    flows: z.array(SmokeFlowResultSchema).max(1_000),
    evidenceArtifactIds: z.array(idSchema('art')).max(10_000),
  })
  .strict();

export const ProductionEvidenceBlockSchema = z
  .object({
    status: z.enum(['passed', 'failed']),
    healthEndpoint: HealthEndpointEvidenceSchema,
    errorRate: ErrorRateEvidenceSchema,
    smoke: ProductionSmokeEvidenceSchema,
  })
  .strict();
export type ProductionEvidenceBlock = z.infer<typeof ProductionEvidenceBlockSchema>;

/** DEP-7's immutable extension of the VF-15 release evidence contract. */
export const ReleaseEvidenceWithProductionSchema = EvidenceManifestSchema.extend({
  production: ProductionEvidenceBlockSchema,
}).strict();
export type ReleaseEvidenceWithProduction = z.infer<typeof ReleaseEvidenceWithProductionSchema>;

const HealthProbeInputSchema = z
  .object({
    idempotencyKey: ActivityKeySchema,
    deploymentId: idSchema('dep'),
    url: HttpsUrlSchema,
    timeoutMs: z.number().int().positive().max(60_000),
  })
  .strict();
type HealthProbeInput = z.infer<typeof HealthProbeInputSchema>;

const HealthProbeResultSchema = z
  .object({
    statusCode: z.number().int().min(100).max(599),
    evidenceArtifactId: idSchema('art').optional(),
  })
  .strict();

const LogInspectionInputSchema = z
  .object({
    idempotencyKey: ActivityKeySchema,
    deploymentId: idSchema('dep'),
    providerDeploymentId: z.string().trim().min(1).max(1_024),
    windowMs: z.literal(PRODUCTION_ERROR_RATE_WINDOW_MS),
  })
  .strict();
type LogInspectionInput = z.infer<typeof LogInspectionInputSchema>;

const LogInspectionResultSchema = z
  .object({
    burstDetected: z.boolean(),
    evidenceArtifactIds: z.array(idSchema('art')).max(1_000),
  })
  .strict();

const ProductionSmokeInputSchema = z
  .object({
    idempotencyKey: ActivityKeySchema,
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    releaseId: idSchema('rel'),
    deploymentId: idSchema('dep'),
    productionUrl: HttpsUrlSchema,
    flows: z.array(ProductionFlowSchema).min(1).max(1_000),
  })
  .strict();
type ProductionSmokeInput = z.infer<typeof ProductionSmokeInputSchema>;

const ProductionSmokeResultSchema = z
  .object({
    flowResults: z.array(SmokeFlowResultSchema).max(1_000),
    evidenceArtifactIds: z.array(idSchema('art')).max(10_000),
  })
  .strict();

const EvidenceAttachmentInputSchema = z
  .object({
    idempotencyKey: ActivityKeySchema,
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    releaseId: idSchema('rel'),
    deploymentId: idSchema('dep'),
    production: ProductionEvidenceBlockSchema,
  })
  .strict();
type EvidenceAttachmentInput = z.infer<typeof EvidenceAttachmentInputSchema>;

const EvidenceAttachmentResultSchema = z.object({ evidenceArtifactId: idSchema('art') }).strict();

const FailureActivityInputSchema = z
  .object({
    idempotencyKey: ActivityKeySchema,
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    releaseId: idSchema('rel'),
    deploymentId: idSchema('dep'),
    reason: z.literal('production_health_failed'),
  })
  .strict();
type FailureActivityInput = z.infer<typeof FailureActivityInputSchema>;

const RollbackOfferInputSchema = FailureActivityInputSchema.extend({
  type: z.literal('deployment.updated'),
  previousHealthyDeploymentId: idSchema('dep').nullable(),
  automaticRollback: z.boolean(),
}).strict();
type RollbackOfferInput = z.infer<typeof RollbackOfferInputSchema>;

const AutomaticRollbackInputSchema = FailureActivityInputSchema.extend({
  environmentId: idSchema('env'),
  toDeploymentId: idSchema('dep'),
}).strict();
type AutomaticRollbackInput = z.infer<typeof AutomaticRollbackInputSchema>;

const ProductionHealthPolicyInputSchema = z
  .object({
    idempotencyKey: ActivityKeySchema,
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    releaseId: idSchema('rel'),
  })
  .strict();
type ProductionHealthPolicyInput = z.infer<typeof ProductionHealthPolicyInputSchema>;

const ProductionHealthPolicyResultSchema = z
  .object({
    supportLevel: SupportLevelSchema,
    autoRollbackOnFailedHealth: z.boolean().optional(),
  })
  .strict();

export interface ProductionHealthDependencies {
  readonly health: {
    probe(input: HealthProbeInput): Promise<unknown>;
  };
  readonly wait: {
    forMs(milliseconds: number): Promise<void>;
  };
  readonly logs: {
    inspectFirstWindow(input: LogInspectionInput): Promise<unknown>;
  };
  readonly smoke: {
    run(input: ProductionSmokeInput): Promise<unknown>;
  };
  readonly evidence: {
    attachProduction(input: EvidenceAttachmentInput): Promise<unknown>;
  };
  readonly policy: {
    resolve(input: ProductionHealthPolicyInput): Promise<unknown>;
  };
  readonly lifecycle: {
    markFailed(input: FailureActivityInput): Promise<void>;
    emitRollbackOffer(input: RollbackOfferInput): Promise<void>;
    rollback(input: AutomaticRollbackInput): Promise<void>;
  };
}

export const ProductionHealthResultSchema = z
  .object({
    status: z.enum(['healthy', 'failed']),
    evidenceArtifactId: idSchema('art'),
    automaticRollbackAttempted: z.boolean(),
    production: ProductionEvidenceBlockSchema,
  })
  .strict();
export type ProductionHealthResult = z.infer<typeof ProductionHealthResultSchema>;

export interface ProductionHealthService {
  verify(input: ProductionHealthInput): Promise<ProductionHealthResult>;
}

const READ_ONLY_FLOW_STEPS = new Set<z.infer<typeof ProductionFlowStepSchema>['kind']>([
  'navigate',
  'assert_visible',
  'assert_text',
  'read_text',
  'snapshot',
]);

export function selectProductionSafeFlows(flowsValue: unknown): ProductionFlow[] {
  return z
    .array(ProductionFlowSchema)
    .max(1_000)
    .parse(flowsValue)
    .filter(
      (flow) =>
        flow.critical &&
        flow.tags.includes('@prod-safe') &&
        flow.steps.every(
          ({ kind, value }) =>
            READ_ONLY_FLOW_STEPS.has(kind) &&
            (kind !== 'navigate' || AppPathSchema.safeParse(value).success),
        ),
    );
}

function activityKey(input: ProductionHealthInput, suffix: string): string {
  return ActivityKeySchema.parse(`${input.operationKey}:${suffix}`);
}

function healthUrl(input: ProductionHealthInput): string {
  return HttpsUrlSchema.parse(new URL(input.healthPath, input.productionUrl).toString());
}

async function runHealthProbes(
  input: ProductionHealthInput,
  dependencies: ProductionHealthDependencies,
): Promise<z.infer<typeof HealthEndpointEvidenceSchema>> {
  const attempts: z.infer<typeof HealthAttemptSchema>[] = [];
  for (let index = 0; index < PRODUCTION_HEALTH_ATTEMPTS; index += 1) {
    try {
      const result = HealthProbeResultSchema.parse(
        await dependencies.health.probe(
          HealthProbeInputSchema.parse({
            idempotencyKey: activityKey(input, `health_probe:${String(index + 1)}`),
            deploymentId: input.deploymentId,
            url: healthUrl(input),
            timeoutMs: PRODUCTION_HEALTH_INTERVAL_MS,
          }),
        ),
      );
      attempts.push(
        HealthAttemptSchema.parse({
          statusCode: result.statusCode,
          ...(result.evidenceArtifactId === undefined
            ? {}
            : { evidenceArtifactId: result.evidenceArtifactId }),
        }),
      );
    } catch {
      attempts.push(HealthAttemptSchema.parse({ statusCode: null }));
    }
    if (index + 1 < PRODUCTION_HEALTH_ATTEMPTS) {
      await dependencies.wait.forMs(PRODUCTION_HEALTH_INTERVAL_MS);
    }
  }
  return HealthEndpointEvidenceSchema.parse({
    status: attempts.every(({ statusCode }) => statusCode === 200) ? 'passed' : 'failed',
    path: input.healthPath,
    intervalMs: PRODUCTION_HEALTH_INTERVAL_MS,
    attempts,
  });
}

async function inspectErrorRate(
  input: ProductionHealthInput,
  dependencies: ProductionHealthDependencies,
): Promise<z.infer<typeof ErrorRateEvidenceSchema>> {
  try {
    const result = LogInspectionResultSchema.parse(
      await dependencies.logs.inspectFirstWindow(
        LogInspectionInputSchema.parse({
          idempotencyKey: activityKey(input, 'error_rate:first_window'),
          deploymentId: input.deploymentId,
          providerDeploymentId: input.providerDeploymentId,
          windowMs: PRODUCTION_ERROR_RATE_WINDOW_MS,
        }),
      ),
    );
    return ErrorRateEvidenceSchema.parse({
      status: result.burstDetected ? 'failed' : 'passed',
      windowMs: PRODUCTION_ERROR_RATE_WINDOW_MS,
      burstDetected: result.burstDetected,
      evidenceArtifactIds: result.evidenceArtifactIds,
    });
  } catch {
    return ErrorRateEvidenceSchema.parse({
      status: 'failed',
      windowMs: PRODUCTION_ERROR_RATE_WINDOW_MS,
      burstDetected: null,
      evidenceArtifactIds: [],
    });
  }
}

function assertSmokeResultSet(
  flows: readonly ProductionFlow[],
  results: readonly z.infer<typeof SmokeFlowResultSchema>[],
): void {
  const expected = flows.map(({ id }) => id).sort();
  const actual = results.map(({ flowId }) => flowId).sort();
  if (
    new Set(actual).size !== actual.length ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw new Error('production_smoke_result_set_mismatch');
  }
}

async function runProductionSmoke(
  input: ProductionHealthInput,
  dependencies: ProductionHealthDependencies,
): Promise<z.infer<typeof ProductionSmokeEvidenceSchema>> {
  const flows = selectProductionSafeFlows(input.criticalFlows);
  if (flows.length === 0) {
    return ProductionSmokeEvidenceSchema.parse({
      status: 'not_applicable',
      flows: [],
      evidenceArtifactIds: [],
    });
  }
  try {
    const result = ProductionSmokeResultSchema.parse(
      await dependencies.smoke.run(
        ProductionSmokeInputSchema.parse({
          idempotencyKey: activityKey(input, 'production_smoke'),
          organizationId: input.organizationId,
          projectId: input.projectId,
          releaseId: input.releaseId,
          deploymentId: input.deploymentId,
          productionUrl: input.productionUrl,
          flows,
        }),
      ),
    );
    assertSmokeResultSet(flows, result.flowResults);
    return ProductionSmokeEvidenceSchema.parse({
      status: result.flowResults.every(({ status }) => status === 'passed') ? 'passed' : 'failed',
      flows: result.flowResults,
      evidenceArtifactIds: result.evidenceArtifactIds,
    });
  } catch {
    return ProductionSmokeEvidenceSchema.parse({
      status: 'failed',
      flows: flows.map(({ id }) => ({ flowId: id, status: 'failed' })),
      evidenceArtifactIds: [],
    });
  }
}

function failureInput(input: ProductionHealthInput) {
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    releaseId: input.releaseId,
    deploymentId: input.deploymentId,
    reason: 'production_health_failed' as const,
  };
}

export function createProductionHealthService(
  dependencies: ProductionHealthDependencies,
): ProductionHealthService {
  return {
    async verify(rawInput) {
      const input = ProductionHealthInputSchema.parse(rawInput);
      const healthEndpoint = await runHealthProbes(input, dependencies);
      const errorRate =
        healthEndpoint.status === 'passed'
          ? await inspectErrorRate(input, dependencies)
          : ErrorRateEvidenceSchema.parse({
              status: 'not_run',
              windowMs: PRODUCTION_ERROR_RATE_WINDOW_MS,
              burstDetected: null,
              evidenceArtifactIds: [],
            });
      const smoke =
        healthEndpoint.status === 'passed' && errorRate.status === 'passed'
          ? await runProductionSmoke(input, dependencies)
          : ProductionSmokeEvidenceSchema.parse({
              status: 'not_run',
              flows: [],
              evidenceArtifactIds: [],
            });
      const production = ProductionEvidenceBlockSchema.parse({
        status:
          healthEndpoint.status === 'failed' ||
          errorRate.status === 'failed' ||
          smoke.status === 'failed'
            ? 'failed'
            : 'passed',
        healthEndpoint,
        errorRate,
        smoke,
      });

      let automaticRollbackAttempted = false;
      if (production.status === 'failed') {
        await dependencies.lifecycle.markFailed(
          FailureActivityInputSchema.parse({
            ...failureInput(input),
            idempotencyKey: activityKey(input, 'mark_failed'),
          }),
        );
        const policy = ProductionHealthPolicyResultSchema.parse(
          await dependencies.policy.resolve(
            ProductionHealthPolicyInputSchema.parse({
              idempotencyKey: activityKey(input, 'policy:production_health'),
              organizationId: input.organizationId,
              projectId: input.projectId,
              releaseId: input.releaseId,
            }),
          ),
        );
        const autoRollbackEnabled =
          policy.autoRollbackOnFailedHealth ?? policy.supportLevel === 'managed';
        const canRollback = autoRollbackEnabled && input.previousHealthyDeploymentId !== null;
        await dependencies.lifecycle.emitRollbackOffer(
          RollbackOfferInputSchema.parse({
            ...failureInput(input),
            idempotencyKey: activityKey(input, 'rollback_offer'),
            type: 'deployment.updated',
            previousHealthyDeploymentId: input.previousHealthyDeploymentId,
            automaticRollback: canRollback,
          }),
        );
        if (canRollback && input.previousHealthyDeploymentId !== null) {
          automaticRollbackAttempted = true;
          await dependencies.lifecycle.rollback(
            AutomaticRollbackInputSchema.parse({
              ...failureInput(input),
              idempotencyKey: activityKey(input, 'auto_rollback'),
              environmentId: input.environmentId,
              toDeploymentId: input.previousHealthyDeploymentId,
            }),
          );
        }
      }

      const attachment = EvidenceAttachmentResultSchema.parse(
        await dependencies.evidence.attachProduction(
          EvidenceAttachmentInputSchema.parse({
            idempotencyKey: activityKey(input, 'evidence:production'),
            organizationId: input.organizationId,
            projectId: input.projectId,
            releaseId: input.releaseId,
            deploymentId: input.deploymentId,
            production,
          }),
        ),
      );
      return ProductionHealthResultSchema.parse({
        status: production.status === 'passed' ? 'healthy' : 'failed',
        evidenceArtifactId: attachment.evidenceArtifactId,
        automaticRollbackAttempted,
        production,
      });
    },
  };
}
