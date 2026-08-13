import { idSchema, internalRepoRef } from '@zapp/contracts';
import { z } from 'zod';

import type { ApprovedTemplateRegistry } from '../template-registry.js';
import {
  DEFAULT_TOKEN_TTL_SECONDS,
  type ApprovedTemplateTokenService,
  type MintedToken,
  type TokenAccess,
} from '../tokens.js';
import type {
  CommitComparison,
  RepositoryOperations,
  RepositorySeedResult,
} from './repository-operations.js';
import { RepositoryOperationError } from './repository-operations.js';
import type { BranchRef } from './types.js';

const ProjectIdentitySchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
  })
  .strict();

const CompareRepositoryCommitsSchema = ProjectIdentitySchema.extend({
  beforeSha: z.string().regex(/^[0-9a-f]{40}$/u, 'Invalid commit sha'),
  afterSha: z.string().regex(/^[0-9a-f]{40}$/u, 'Invalid commit sha'),
}).strict();

const SeedApprovedTemplateSchema = ProjectIdentitySchema.extend({
  templateSlug: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'Invalid template slug'),
  operationKey: z
    .string()
    .min(8)
    .max(255)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, 'Invalid operation key'),
}).strict();

export type CompareRepositoryCommitsInput = z.infer<typeof CompareRepositoryCommitsSchema>;
export type SeedApprovedTemplateInput = z.infer<typeof SeedApprovedTemplateSchema>;

export interface RepositoryFeatures {
  compare(input: CompareRepositoryCommitsInput): Promise<CommitComparison>;
  seedApprovedTemplate(input: SeedApprovedTemplateInput): Promise<RepositorySeedResult>;
}

export class ApprovedTemplateNotFoundError extends Error {
  constructor() {
    super('approved template does not exist');
    this.name = 'ApprovedTemplateNotFoundError';
  }
}

export interface RepositoryFeaturesOptions {
  readonly registry: ApprovedTemplateRegistry;
  readonly tokens: ApprovedTemplateTokenService;
  readonly operations: RepositoryOperations;
  readonly headReader: {
    getBranch(ref: string, branch: string): Promise<BranchRef | undefined>;
  };
  readonly headPoll?: {
    readonly attempts: number;
    readonly delay: () => Promise<void>;
  };
}

/**
 * Binds low-level Git operations to server-owned source identity and a single
 * tenant project's ephemeral credential. A route can name ids, commits, a
 * registry slug and an operation key; it cannot express a clone URL or token.
 */
export function createRepositoryFeatures(options: RepositoryFeaturesOptions): RepositoryFeatures {
  const { registry, tokens, operations, headReader } = options;
  const headPoll = options.headPoll ?? {
    attempts: 100,
    delay: () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
  };
  if (!Number.isInteger(headPoll.attempts) || headPoll.attempts <= 0) {
    throw new Error('headPoll.attempts must be a positive integer');
  }

  async function waitForSeededHead(
    project: z.infer<typeof ProjectIdentitySchema>,
    expectedSha: string,
  ): Promise<void> {
    const ref = internalRepoRef(project);
    for (let attempt = 0; attempt < headPoll.attempts; attempt += 1) {
      const branch = await headReader.getBranch(ref, 'main');
      if (branch?.headSha === expectedSha) return;
      if (attempt + 1 < headPoll.attempts) await headPoll.delay();
    }
    throw new RepositoryOperationError();
  }

  async function withProjectCredential<T>(
    project: z.infer<typeof ProjectIdentitySchema>,
    access: TokenAccess,
    operation: (credential: MintedToken) => Promise<T>,
  ): Promise<T> {
    const credential = await tokens.mint({
      ...project,
      access,
      ttlSec: DEFAULT_TOKEN_TTL_SECONDS,
      requestingService: 'control-api',
    });
    try {
      return await operation(credential);
    } finally {
      await tokens.revokeEphemeral({
        ...project,
        username: credential.username,
        requestingService: 'control-api',
      });
    }
  }

  return {
    async compare(rawInput) {
      const input = CompareRepositoryCommitsSchema.parse(rawInput);
      const project = {
        organizationId: input.organizationId,
        projectId: input.projectId,
      };
      return await withProjectCredential(project, 'read', async (credential) =>
        operations.compare({
          repository: {
            cloneUrl: credential.cloneUrl,
            username: credential.username,
            credential: credential.token,
          },
          beforeSha: input.beforeSha,
          afterSha: input.afterSha,
        }),
      );
    },

    async seedApprovedTemplate(rawInput) {
      const input = SeedApprovedTemplateSchema.parse(rawInput);
      const source = registry.resolveApprovedSource(input.templateSlug);
      if (source === undefined) throw new ApprovedTemplateNotFoundError();
      const project = {
        organizationId: input.organizationId,
        projectId: input.projectId,
      };
      const sourceCredential = await tokens.mintApprovedTemplateSource({
        ...project,
        repositoryRef: source.repoRef,
        ttlSec: DEFAULT_TOKEN_TTL_SECONDS,
        requestingService: 'control-api',
      });
      try {
        return await withProjectCredential(project, 'write', async (credential) => {
          const result = await operations.seed({
            source: {
              cloneUrl: sourceCredential.cloneUrl,
              username: sourceCredential.username,
              credential: sourceCredential.token,
            },
            target: {
              cloneUrl: credential.cloneUrl,
              username: credential.username,
              credential: credential.token,
            },
            sourceCommitSha: source.commitSha,
            sourceIdentity: source.repoRef,
            targetIdentity: internalRepoRef(project),
            operationKey: input.operationKey,
          });
          // Forgejo applies push bookkeeping asynchronously. Keep the writer
          // identity alive until the API records the exact head; deleting it
          // earlier makes Forgejo's background pushUpdate fail by user id.
          await waitForSeededHead(project, result.headCommitSha);
          return result;
        });
      } finally {
        await tokens.revokeApprovedTemplateSource({
          ...project,
          repositoryRef: source.repoRef,
          username: sourceCredential.username,
          requestingService: 'control-api',
        });
      }
    },
  };
}
