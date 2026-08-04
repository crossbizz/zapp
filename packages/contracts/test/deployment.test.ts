import { describe, expect, it } from 'vitest';
import {
  CommitShaSchema,
  CompatibilityResultSchema,
  DeploymentArtifactSchema,
  DeploymentHandleSchema,
  DeploymentLogSchema,
  DeploymentStatusSchema,
  DnsInstructionSchema,
  DomainInputSchema,
  DomainResultSchema,
  EnvironmentIdSchema,
  PreviewDeploymentInputSchema,
  ProductionDeploymentInputSchema,
  RollbackInputSchema,
} from '../src/deployment.js';

// Round-trips only: the vocabularies here (deployment state, domain status, artifact
// kind) are v1 shapes, not PRD-fixed lists, so they are deliberately not pinned —
// plan 07 may still widen them.

const commitSha = '9f2c1b4ad3e5f6071829a0b1c2d3e4f5061728a9';
const projectId = 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB';
const artifact = { kind: 'container_image', reference: 'registry.fly.io/zapp-proj:9f2c1b4' };

describe('deployment provider inputs', () => {
  it('round-trips every input the provider accepts', () => {
    const previewInput = { projectId, commitSha, artifact, env: { NODE_ENV: 'production' } };
    expect(PreviewDeploymentInputSchema.parse(previewInput)).toEqual(previewInput);

    const productionInput = {
      projectId,
      environmentId: 'env-production',
      releaseId: 'rel_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
      commitSha,
      artifact,
      env: { NODE_ENV: 'production', DATABASE_URL: 'postgres://redacted' },
    };
    expect(ProductionDeploymentInputSchema.parse(productionInput)).toEqual(productionInput);

    const domainInput = { projectId, environmentId: 'env-production', hostname: 'app.example.com' };
    expect(DomainInputSchema.parse(domainInput)).toEqual(domainInput);

    const rollbackInput = {
      projectId,
      environmentId: 'env-production',
      toProviderDeploymentId: 'dpl_abc123',
      reason: 'error rate spike after go-live',
    };
    expect(RollbackInputSchema.parse(rollbackInput)).toEqual(rollbackInput);

    expect(DeploymentArtifactSchema.parse(artifact)).toEqual(artifact);
  });

  it('rejects a commit reference that is not a resolved sha', () => {
    expect(CommitShaSchema.parse(commitSha)).toBe(commitSha);
    expect(CommitShaSchema.safeParse('main').success).toBe(false);
    expect(CommitShaSchema.safeParse(commitSha.toUpperCase()).success).toBe(false);
    expect(EnvironmentIdSchema.safeParse('').success).toBe(false);
  });
});

describe('deployment provider outputs', () => {
  it('round-trips every result the provider returns', () => {
    const compatibility = {
      providerId: 'fly',
      compatible: true,
      reasons: ['build and start commands present'],
    };
    expect(CompatibilityResultSchema.parse(compatibility)).toEqual(compatibility);

    const handle = {
      providerId: 'fly',
      providerDeploymentId: 'dpl_abc123',
      url: 'https://zapp-proj.fly.dev',
      state: 'deploying',
      createdAt: '2026-08-03T12:00:00.000Z',
    };
    expect(DeploymentHandleSchema.parse(handle)).toEqual(handle);

    const status = {
      providerDeploymentId: 'dpl_abc123',
      state: 'failed',
      detail: 'health check returned 502 three times',
      updatedAt: '2026-08-03T12:04:00.000Z',
    };
    expect(DeploymentStatusSchema.parse(status)).toEqual(status);

    const log = {
      at: '2026-08-03T12:03:59.000Z',
      stream: 'stderr',
      message: 'Error: connect ECONNREFUSED 127.0.0.1:5432',
    };
    expect(DeploymentLogSchema.parse(log)).toEqual(log);

    const dnsInstruction = { type: 'CNAME', name: 'app', value: 'zapp-proj.fly.dev' };
    expect(DnsInstructionSchema.parse(dnsInstruction)).toEqual(dnsInstruction);

    const domainResult = {
      hostname: 'app.example.com',
      status: 'pending_dns',
      dnsInstructions: [dnsInstruction],
    };
    expect(DomainResultSchema.parse(domainResult)).toEqual(domainResult);
  });

  it('rejects a deployment URL that is not https', () => {
    const handle = {
      providerId: 'fly',
      providerDeploymentId: 'dpl_abc123',
      state: 'ready',
      createdAt: '2026-08-03T12:00:00.000Z',
    };
    expect(
      DeploymentHandleSchema.safeParse({ ...handle, url: 'http://zapp-proj.fly.dev' }).success,
    ).toBe(false);
    expect(
      DeploymentStatusSchema.safeParse({
        providerDeploymentId: 'dpl_abc123',
        state: 'ready',
        url: 'http://zapp-proj.fly.dev',
        updatedAt: '2026-08-03T12:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
