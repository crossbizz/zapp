import { idSchema } from '@zapp/contracts';
import { EvidenceManifestSchema, type EvidenceManifest } from '@zapp/verification-engine';
import { z } from 'zod';

import { ReadinessReportSchema, type ReadinessReport } from './release/readiness.js';
import { DeploymentConfirmationSchema, DeploymentTypeSchema } from './release/types.js';
import { ReleaseServiceError, type Release, type ReleaseRecordService } from './release/create.js';

export const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);

export const ReleaseLookupInputSchema = z
  .object({
    organizationId: idSchema('org'),
    releaseId: idSchema('rel'),
  })
  .strict();
export type ReleaseLookupInput = z.infer<typeof ReleaseLookupInputSchema>;

export const ReleaseLifecycleMutationInputSchema = ReleaseLookupInputSchema.extend({
  actorId: idSchema('user'),
  operationKey: OperationKeySchema,
}).strict();

export const DeployReleaseInputSchema = ReleaseLifecycleMutationInputSchema.extend({
  deploymentType: DeploymentTypeSchema,
  confirmation: DeploymentConfirmationSchema,
}).strict();
export type DeployReleaseInput = z.infer<typeof DeployReleaseInputSchema>;

export const RollbackReleaseInputSchema = ReleaseLifecycleMutationInputSchema.extend({
  toDeploymentId: idSchema('dep').nullable(),
  reason: z.string().trim().min(1).max(2_000),
}).strict();
export type RollbackReleaseInput = z.infer<typeof RollbackReleaseInputSchema>;

export const DeploymentResultSchema = z.object({ deploymentId: idSchema('dep') }).strict();
export type DeploymentResult = z.infer<typeof DeploymentResultSchema>;

export const ForkReleaseInputSchema = ReleaseLifecycleMutationInputSchema.extend({
  startFixRun: z.boolean(),
}).strict();
export type ForkReleaseInput = z.infer<typeof ForkReleaseInputSchema>;

export const ForkReleaseResultSchema = z
  .object({
    releaseId: idSchema('rel'),
    branchId: idSchema('br'),
    branchName: z.string().trim().min(1).max(255),
    fixRunId: idSchema('run').nullable(),
  })
  .strict();
export type ForkReleaseResult = z.infer<typeof ForkReleaseResultSchema>;

/**
 * DEP-12's callable lifecycle boundary. The six ReleasePort operations stay
 * unchanged; release repair is a separately named method because ADR-0012
 * freezes that interface at six methods.
 */
export interface ReleaseLifecycleService {
  getReadiness(input: ReleaseLookupInput): Promise<ReadinessReport>;
  deploy(input: DeployReleaseInput): Promise<DeploymentResult>;
  rollback(input: RollbackReleaseInput): Promise<DeploymentResult>;
  getEvidence(input: ReleaseLookupInput): Promise<EvidenceManifest>;
  forkRelease(input: ForkReleaseInput): Promise<ForkReleaseResult>;
}

export interface ReleaseLifecycleDependencies {
  readonly records: ReleaseRecordService;
  readonly readiness: {
    evaluate(release: Release): Promise<unknown>;
  };
  readonly deployments: {
    deploy(release: Release, input: DeployReleaseInput): Promise<unknown>;
    rollback(release: Release, input: RollbackReleaseInput): Promise<unknown>;
  };
  readonly evidence: {
    get(release: Release): Promise<unknown>;
  };
  readonly repair: {
    fork(release: Release, input: ForkReleaseInput): Promise<unknown>;
  };
}

async function releaseFor(
  dependencies: ReleaseLifecycleDependencies,
  input: ReleaseLookupInput,
): Promise<Release> {
  const release = await dependencies.records.getRelease(input.organizationId, input.releaseId);
  if (release === undefined) {
    throw new ReleaseServiceError('release_not_found', 404, 'Release not found.');
  }
  return release;
}

/**
 * The production lifecycle coordinator. Provider/state-machine adapters remain
 * injected, while this layer owns tenant lookup and immutable release identity
 * checks for every projection and mutation.
 */
export function createReleaseLifecycleService(
  dependencies: ReleaseLifecycleDependencies,
): ReleaseLifecycleService {
  return {
    async getReadiness(rawInput) {
      const input = ReleaseLookupInputSchema.parse(rawInput);
      const release = await releaseFor(dependencies, input);
      const result = ReadinessReportSchema.parse(await dependencies.readiness.evaluate(release));
      if (result.releaseId !== release.id || result.commitSha !== release.commitSha) {
        throw new Error('release_readiness_identity_mismatch');
      }
      return result;
    },

    async deploy(rawInput) {
      const input = DeployReleaseInputSchema.parse(rawInput);
      const release = await releaseFor(dependencies, input);
      if (
        release.status !== 'approved' &&
        release.status !== 'deploying' &&
        release.status !== 'healthy'
      ) {
        throw new ReleaseServiceError(
          'invalid_release_transition',
          409,
          `Release status ${release.status} cannot begin deployment.`,
        );
      }
      if (release.status === 'approved') {
        const readiness = ReadinessReportSchema.parse(
          await dependencies.readiness.evaluate(release),
        );
        if (
          readiness.releaseId !== release.id ||
          readiness.commitSha !== release.commitSha ||
          readiness.state === 'blocked'
        ) {
          throw new ReleaseServiceError(
            'invalid_release_transition',
            409,
            'The approved release no longer satisfies deployment readiness.',
          );
        }
      }
      const deploying =
        release.status === 'approved' ? await dependencies.records.beginDeployment(input) : release;
      return DeploymentResultSchema.parse(await dependencies.deployments.deploy(deploying, input));
    },

    async rollback(rawInput) {
      const input = RollbackReleaseInputSchema.parse(rawInput);
      const release = await releaseFor(dependencies, input);
      return DeploymentResultSchema.parse(await dependencies.deployments.rollback(release, input));
    },

    async getEvidence(rawInput) {
      const input = ReleaseLookupInputSchema.parse(rawInput);
      const release = await releaseFor(dependencies, input);
      const result = EvidenceManifestSchema.parse(await dependencies.evidence.get(release));
      if (result.release_id !== release.id || result.commit_sha !== release.commitSha) {
        throw new Error('release_evidence_identity_mismatch');
      }
      return result;
    },

    async forkRelease(rawInput) {
      const input = ForkReleaseInputSchema.parse(rawInput);
      const release = await releaseFor(dependencies, input);
      const result = ForkReleaseResultSchema.parse(await dependencies.repair.fork(release, input));
      if (
        result.releaseId !== release.id ||
        result.branchName !== `fix/rel-${release.id}` ||
        (result.fixRunId === null) === input.startFixRun
      ) {
        throw new Error('release_fork_identity_mismatch');
      }
      return result;
    },
  };
}

export { EvidenceManifestSchema, ReadinessReportSchema };
