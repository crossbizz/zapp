import { z } from 'zod';
import type {
  AnyToolSpec,
  ToolExecutionContext,
  ToolMutationContext,
  ToolSpec,
} from './registry.js';
import { mutationContext } from './registry.js';

const commitSchema = z.string().regex(/^[0-9a-f]{7,64}$/iu);
const deploymentTypeSchema = z.enum(['first_deploy', 'redeploy', 'replace_deployment']);

const CreatePreviewInputSchema = z
  .object({ branchId: z.string().min(1), commitSha: commitSchema })
  .strict();
const PreviewSmokeInputSchema = z.object({ previewId: z.string().min(1) }).strict();
const ReleaseCandidateInputSchema = z
  .object({
    environmentId: z.string().min(1),
    commitSha: commitSchema,
    specificationId: z.string().min(1),
  })
  .strict();
const DeployReleaseInputSchema = z
  .object({
    releaseId: z.string().min(1),
    deploymentType: deploymentTypeSchema,
    confirmationId: z.string().min(1),
  })
  .strict();
const DeploymentHealthInputSchema = z
  .object({ deploymentId: z.string().min(1) })
  .strict();
const RollbackReleaseInputSchema = z
  .object({
    environmentId: z.string().min(1),
    toDeploymentId: z.string().min(1).optional(),
    reason: z.string().min(1),
  })
  .strict();

const PreviewPortOutputSchema = z
  .object({ previewId: z.string().min(1), url: z.string().url() })
  .strict();
const PreviewOutputSchema = PreviewPortOutputSchema.extend({ ok: z.literal(true) }).strict();
const SmokePortOutputSchema = z.object({ passed: z.boolean(), summary: z.string() }).strict();
const SmokeOutputSchema = z.discriminatedUnion('passed', [
  z.object({ ok: z.literal(true), passed: z.literal(true), summary: z.string() }).strict(),
  z.object({ ok: z.literal(false), passed: z.literal(false), summary: z.string() }).strict(),
]);
const CandidatePortOutputSchema = z
  .object({ id: z.string().min(1), status: z.literal('candidate') })
  .strict();
const CandidateOutputSchema = z
  .object({ ok: z.literal(true), releaseId: z.string().min(1), status: z.literal('candidate') })
  .strict();
const DeploymentPortOutputSchema = z.object({ deploymentId: z.string().min(1) }).strict();
const DeployOutputSchema = z
  .object({ ok: z.literal(true), deploymentId: z.string().min(1), status: z.literal('deploying') })
  .strict();
const HealthPortOutputSchema = z.object({ healthy: z.boolean(), details: z.string() }).strict();
const HealthOutputSchema = z.discriminatedUnion('healthy', [
  z.object({ ok: z.literal(true), healthy: z.literal(true), details: z.string() }).strict(),
  z.object({ ok: z.literal(false), healthy: z.literal(false), details: z.string() }).strict(),
]);
const RollbackOutputSchema = z
  .object({
    ok: z.literal(true),
    deploymentId: z.string().min(1),
    status: z.literal('rolling_back'),
  })
  .strict();

export interface ReleaseCallOptions {
  readonly context: ToolExecutionContext;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

/** Binding Plan 07 DEP-1 method set. Tool-only operations live on separate adapters below. */
export interface ReleasePort {
  createReleaseCandidate(
    input: {
      readonly projectId: string;
      readonly environmentId: string;
      readonly commitSha: string;
      readonly specificationId: string;
    },
    options?: ReleaseCallOptions,
  ): Promise<unknown>;
  getReadiness(releaseId: string, signal?: AbortSignal): Promise<unknown>;
  approve(releaseId: string, actor: unknown, signal?: AbortSignal): Promise<unknown>;
  deploy(
    releaseId: string,
    input: {
      readonly deploymentType: z.infer<typeof deploymentTypeSchema>;
      readonly confirmation: { readonly id: string };
    },
    options?: ReleaseCallOptions,
  ): Promise<unknown>;
  rollback(
    input: {
      readonly environmentId: string;
      readonly toDeploymentId?: string;
      readonly reason: string;
    },
    options?: ReleaseCallOptions,
  ): Promise<unknown>;
  getEvidence(releaseId: string, signal?: AbortSignal): Promise<unknown>;
}

export interface PreviewToolPort {
  createPreview(
    input: z.infer<typeof CreatePreviewInputSchema>,
    context: ToolMutationContext,
    signal: AbortSignal,
  ): Promise<unknown>;
  runPreviewSmokeTest(
    input: z.infer<typeof PreviewSmokeInputSchema>,
    context: ToolMutationContext,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface DeploymentHealthPort {
  checkDeploymentHealth(
    input: z.infer<typeof DeploymentHealthInputSchema>,
    context: ToolMutationContext,
    signal: AbortSignal,
  ): Promise<unknown>;
}

function releaseOptions(
  context: ToolExecutionContext,
  tool: 'create_release_candidate' | 'deploy_release' | 'rollback_release',
  signal: AbortSignal,
): ReleaseCallOptions {
  return {
    context,
    idempotencyKey: mutationContext(context, tool).idempotencyKey,
    signal,
  };
}

function releaseTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  spec: Omit<ToolSpec<I, O>, 'classification' | 'riskLevel' | 'retryPolicy' | 'redactOutput'>,
): AnyToolSpec {
  return {
    ...spec,
    classification: 'mutating',
    riskLevel: 'high',
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    redactOutput: true,
  } as unknown as AnyToolSpec;
}

export function createReleaseTools(
  release: ReleasePort,
  preview: PreviewToolPort,
  deploymentHealth: DeploymentHealthPort,
): AnyToolSpec[] {
  return [
    releaseTool({
      name: 'create_preview',
      description: 'Create a project preview through the preview adapter.',
      inputSchema: CreatePreviewInputSchema,
      outputSchema: PreviewOutputSchema,
      approvalPolicy: 'policy',
      idempotent: false,
      timeoutMs: 120_000,
      run: async (input, context, signal) => ({
        ok: true,
        ...PreviewPortOutputSchema.parse(
          await preview.createPreview(
            input,
            mutationContext(context, 'create_preview'),
            signal,
          ),
        ),
      }),
      userSummary: (_input, output) => `Created preview ${output.previewId}`,
      auditPayload: (input, output) => ({
        branchId: input.branchId,
        commitSha: input.commitSha,
        previewId: output.previewId,
      }),
    }),
    releaseTool({
      name: 'run_preview_smoke_test',
      description: 'Run a preview smoke test through the preview adapter.',
      inputSchema: PreviewSmokeInputSchema,
      outputSchema: SmokeOutputSchema,
      approvalPolicy: 'policy',
      idempotent: true,
      timeoutMs: 120_000,
      run: async (input, context, signal) => {
        const output = SmokePortOutputSchema.parse(
          await preview.runPreviewSmokeTest(
            input,
            mutationContext(context, 'run_preview_smoke_test'),
            signal,
          ),
        );
        return { ...output, ok: output.passed };
      },
      userSummary: (input, output) =>
        output.passed
          ? `Preview ${input.previewId} smoke test passed`
          : `Preview ${input.previewId} smoke test failed`,
      auditPayload: (input, output) => ({ previewId: input.previewId, passed: output.passed }),
    }),
    releaseTool({
      name: 'create_release_candidate',
      description: 'Create an immutable release candidate through the Plan 07 release port.',
      inputSchema: ReleaseCandidateInputSchema,
      outputSchema: CandidateOutputSchema,
      approvalPolicy: 'policy',
      idempotent: false,
      timeoutMs: 60_000,
      run: async (input, context, signal) => {
        const output = CandidatePortOutputSchema.parse(
          await release.createReleaseCandidate(
            { projectId: context.projectId, ...input },
            releaseOptions(context, 'create_release_candidate', signal),
          ),
        );
        return { ok: true, releaseId: output.id, status: output.status };
      },
      userSummary: (_input, output) => `Created release candidate ${output.releaseId}`,
      auditPayload: (input, output) => ({
        environmentId: input.environmentId,
        commitSha: input.commitSha,
        releaseId: output.releaseId,
      }),
    }),
    releaseTool({
      name: 'deploy_release',
      description: 'Deploy an approved release through the Plan 07 release port.',
      inputSchema: DeployReleaseInputSchema,
      outputSchema: DeployOutputSchema,
      approvalPolicy: 'human',
      idempotent: false,
      timeoutMs: 120_000,
      run: async (input, context, signal) => {
        const output = DeploymentPortOutputSchema.parse(
          await release.deploy(
            input.releaseId,
            {
              deploymentType: input.deploymentType,
              confirmation: { id: input.confirmationId },
            },
            releaseOptions(context, 'deploy_release', signal),
          ),
        );
        return { ok: true, deploymentId: output.deploymentId, status: 'deploying' as const };
      },
      userSummary: (input, output) =>
        `Deployment ${output.deploymentId} started for release ${input.releaseId}`,
      auditPayload: (input, output) => ({
        releaseId: input.releaseId,
        deploymentId: output.deploymentId,
        deploymentType: input.deploymentType,
      }),
    }),
    releaseTool({
      name: 'check_deployment_health',
      description: 'Check deployment health through the deployment-health adapter.',
      inputSchema: DeploymentHealthInputSchema,
      outputSchema: HealthOutputSchema,
      approvalPolicy: 'policy',
      idempotent: true,
      timeoutMs: 60_000,
      run: async (input, context, signal) => {
        const output = HealthPortOutputSchema.parse(
          await deploymentHealth.checkDeploymentHealth(
            input,
            mutationContext(context, 'check_deployment_health'),
            signal,
          ),
        );
        return { ...output, ok: output.healthy };
      },
      userSummary: (input, output) =>
        output.healthy
          ? `Deployment ${input.deploymentId} is healthy`
          : `Deployment ${input.deploymentId} is unhealthy`,
      auditPayload: (input, output) => ({
        deploymentId: input.deploymentId,
        healthy: output.healthy,
      }),
    }),
    releaseTool({
      name: 'rollback_release',
      description: 'Roll back an environment through the Plan 07 release port.',
      inputSchema: RollbackReleaseInputSchema,
      outputSchema: RollbackOutputSchema,
      approvalPolicy: 'human',
      idempotent: false,
      timeoutMs: 120_000,
      run: async (input, context, signal) => {
        const output = DeploymentPortOutputSchema.parse(
          await release.rollback(
            {
              environmentId: input.environmentId,
              ...(input.toDeploymentId === undefined
                ? {}
                : { toDeploymentId: input.toDeploymentId }),
              reason: input.reason,
            },
            releaseOptions(context, 'rollback_release', signal),
          ),
        );
        return { ok: true, deploymentId: output.deploymentId, status: 'rolling_back' as const };
      },
      userSummary: (input, output) =>
        `Rollback ${output.deploymentId} started for ${input.environmentId}`,
      auditPayload: (input, output) => ({
        environmentId: input.environmentId,
        deploymentId: output.deploymentId,
      }),
    }),
  ];
}
