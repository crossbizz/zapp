import { z } from 'zod';
import type { AnyToolSpec, ToolSpec } from './registry.js';

const attributionFields = {
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
} as const;
const commitSchema = z.string().regex(/^[0-9a-f]{7,64}$/iu);

const CreatePreviewInputSchema = z
  .object({ ...attributionFields, branchId: z.string().min(1), commitSha: commitSchema })
  .strict();
const PreviewSmokeInputSchema = z
  .object({ ...attributionFields, previewId: z.string().min(1) })
  .strict();
const ReleaseCandidateInputSchema = z
  .object({
    ...attributionFields,
    environmentId: z.string().min(1),
    commitSha: commitSchema,
    specificationId: z.string().min(1),
  })
  .strict();
const DeployReleaseInputSchema = z
  .object({
    ...attributionFields,
    releaseId: z.string().min(1),
    deploymentType: z.enum(['managed', 'connected']),
    confirmationId: z.string().min(1),
  })
  .strict();
const DeploymentHealthInputSchema = z
  .object({ ...attributionFields, deploymentId: z.string().min(1) })
  .strict();
const RollbackReleaseInputSchema = z
  .object({
    ...attributionFields,
    environmentId: z.string().min(1),
    toDeploymentId: z.string().min(1).optional(),
    reason: z.string().min(1),
  })
  .strict();

const PreviewOutputSchema = z
  .object({ ok: z.literal(true), previewId: z.string().min(1), url: z.string().url() })
  .strict();
const SmokeOutputSchema = z
  .object({ ok: z.literal(true), passed: z.boolean(), summary: z.string() })
  .strict();
const CandidateOutputSchema = z
  .object({ ok: z.literal(true), releaseId: z.string().min(1), status: z.literal('candidate') })
  .strict();
const DeployOutputSchema = z
  .object({ ok: z.literal(true), deploymentId: z.string().min(1), status: z.literal('deploying') })
  .strict();
const HealthOutputSchema = z
  .object({ ok: z.literal(true), healthy: z.boolean(), details: z.string() })
  .strict();
const RollbackOutputSchema = z
  .object({
    ok: z.literal(true),
    deploymentId: z.string().min(1),
    status: z.literal('rolling_back'),
  })
  .strict();

export interface ReleasePort {
  createPreview(input: z.infer<typeof CreatePreviewInputSchema>): Promise<unknown>;
  runPreviewSmokeTest(input: z.infer<typeof PreviewSmokeInputSchema>): Promise<unknown>;
  createReleaseCandidate(input: z.infer<typeof ReleaseCandidateInputSchema>): Promise<unknown>;
  deployRelease(input: z.infer<typeof DeployReleaseInputSchema>): Promise<unknown>;
  checkDeploymentHealth(input: z.infer<typeof DeploymentHealthInputSchema>): Promise<unknown>;
  rollbackRelease(input: z.infer<typeof RollbackReleaseInputSchema>): Promise<unknown>;
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

export function createReleaseTools(release: ReleasePort): AnyToolSpec[] {
  return [
    releaseTool({
      name: 'create_preview',
      description: 'Create a project preview through the release service.',
      inputSchema: CreatePreviewInputSchema,
      outputSchema: PreviewOutputSchema,
      approvalPolicy: 'policy',
      idempotent: true,
      timeoutMs: 120_000,
      run: (input) => release.createPreview(input),
      userSummary: (_input, output) => `Created preview ${output.previewId}`,
      auditPayload: (input, output) => ({
        projectId: input.projectId,
        branchId: input.branchId,
        commitSha: input.commitSha,
        previewId: output.previewId,
      }),
    }),
    releaseTool({
      name: 'run_preview_smoke_test',
      description: 'Run a preview smoke test through the release service.',
      inputSchema: PreviewSmokeInputSchema,
      outputSchema: SmokeOutputSchema,
      approvalPolicy: 'policy',
      idempotent: true,
      timeoutMs: 120_000,
      run: (input) => release.runPreviewSmokeTest(input),
      userSummary: (input, output) =>
        output.passed
          ? `Preview ${input.previewId} smoke test passed`
          : `Preview ${input.previewId} smoke test failed`,
      auditPayload: (input, output) => ({
        projectId: input.projectId,
        previewId: input.previewId,
        passed: output.passed,
      }),
    }),
    releaseTool({
      name: 'create_release_candidate',
      description: 'Create an immutable release candidate through the release service.',
      inputSchema: ReleaseCandidateInputSchema,
      outputSchema: CandidateOutputSchema,
      approvalPolicy: 'policy',
      idempotent: true,
      timeoutMs: 60_000,
      run: (input) => release.createReleaseCandidate(input),
      userSummary: (_input, output) => `Created release candidate ${output.releaseId}`,
      auditPayload: (input, output) => ({
        projectId: input.projectId,
        environmentId: input.environmentId,
        commitSha: input.commitSha,
        releaseId: output.releaseId,
      }),
    }),
    releaseTool({
      name: 'deploy_release',
      description: 'Deploy an approved release through the release service.',
      inputSchema: DeployReleaseInputSchema,
      outputSchema: DeployOutputSchema,
      approvalPolicy: 'human',
      idempotent: true,
      timeoutMs: 120_000,
      run: (input) => release.deployRelease(input),
      userSummary: (input, output) =>
        `Deployment ${output.deploymentId} started for release ${input.releaseId}`,
      auditPayload: (input, output) => ({
        projectId: input.projectId,
        releaseId: input.releaseId,
        deploymentId: output.deploymentId,
        deploymentType: input.deploymentType,
      }),
    }),
    releaseTool({
      name: 'check_deployment_health',
      description: 'Check deployment health through the release service.',
      inputSchema: DeploymentHealthInputSchema,
      outputSchema: HealthOutputSchema,
      approvalPolicy: 'policy',
      idempotent: true,
      timeoutMs: 60_000,
      run: (input) => release.checkDeploymentHealth(input),
      userSummary: (input, output) =>
        output.healthy
          ? `Deployment ${input.deploymentId} is healthy`
          : `Deployment ${input.deploymentId} is unhealthy`,
      auditPayload: (input, output) => ({
        projectId: input.projectId,
        deploymentId: input.deploymentId,
        healthy: output.healthy,
      }),
    }),
    releaseTool({
      name: 'rollback_release',
      description: 'Roll back an environment through the release service.',
      inputSchema: RollbackReleaseInputSchema,
      outputSchema: RollbackOutputSchema,
      approvalPolicy: 'human',
      idempotent: true,
      timeoutMs: 120_000,
      run: (input) => release.rollbackRelease(input),
      userSummary: (input, output) =>
        `Rollback ${output.deploymentId} started for ${input.environmentId}`,
      auditPayload: (input, output) => ({
        projectId: input.projectId,
        environmentId: input.environmentId,
        deploymentId: output.deploymentId,
      }),
    }),
  ];
}
