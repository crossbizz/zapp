import { CommitShaSchema, idSchema } from '@zapp/contracts';
import {
  integrationConnections,
  projects,
  repositories,
  type Database,
  type Executor,
} from '@zapp/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { GitHubRepositoryFullNameSchema } from './schemas.js';
import { GitHubSyncPolicySchema } from './sync.js';

const GitHubRepositoryNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/u);

const GitHubExportInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    installationId: z.string().trim().min(1).max(200),
    repositoryName: GitHubRepositoryNameSchema,
    private: z.boolean(),
    syncPolicy: GitHubSyncPolicySchema,
    operationKey: z.string().min(8).max(255),
  })
  .strict();

export const GitHubExportTargetSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    internalRepoRef: z.string().trim().min(1),
    defaultBranch: z.string().trim().min(1).max(255),
    externalRepoRef: GitHubRepositoryFullNameSchema.nullable(),
  })
  .strict();

const CreatedGitHubRepositorySchema = z
  .object({
    fullName: GitHubRepositoryFullNameSchema,
    repositoryUrl: z.string().url(),
    cloneUrl: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//u.test(value), 'cloneUrl must use HTTP(S)'),
    token: z.string().min(1),
  })
  .strict();

const PushedHistorySchema = z
  .object({ internalHeadSha: CommitShaSchema, externalHeadSha: CommitShaSchema })
  .strict();

const GitHubExportResultSchema = z
  .object({
    externalRepoRef: GitHubRepositoryFullNameSchema,
    repositoryUrl: z.string().url(),
    syncPolicy: GitHubSyncPolicySchema,
    internalHeadSha: CommitShaSchema,
    externalHeadSha: CommitShaSchema,
  })
  .strict();

const CompleteGitHubExportInputSchema = z
  .object({
    target: GitHubExportTargetSchema,
    installationId: z.string().trim().min(1).max(200),
    externalRepoRef: GitHubRepositoryFullNameSchema,
    syncPolicy: GitHubSyncPolicySchema,
  })
  .strict();

const CompleteGitHubExportResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('linked') }).strict(),
  z
    .object({ status: z.literal('conflict'), externalRepoRef: GitHubRepositoryFullNameSchema })
    .strict(),
  z.object({ status: z.literal('not_found') }).strict(),
]);

export type GitHubExportTarget = z.infer<typeof GitHubExportTargetSchema>;
export type CompleteGitHubExportInput = z.infer<typeof CompleteGitHubExportInputSchema>;
export type CompleteGitHubExportResult = z.infer<typeof CompleteGitHubExportResultSchema>;

export interface GitHubExportStore {
  resolve(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly installationId: string;
  }): Promise<GitHubExportTarget | undefined>;
  complete(input: CompleteGitHubExportInput): Promise<CompleteGitHubExportResult>;
}

export interface GitHubExportProviderPort {
  createRepository(input: {
    readonly installationId: string;
    readonly operationKey: string;
    readonly name: string;
    readonly private: boolean;
  }): Promise<{
    readonly fullName: string;
    readonly repositoryUrl: string;
    readonly cloneUrl: string;
    readonly token: string;
  }>;
  repositoryUrl(externalRepoRef: string): string;
}

export interface GitHubExportGitPort {
  /** Pushes every ref. There is deliberately no force option at this boundary. */
  pushFullHistory(input: {
    readonly internalRepoRef: string;
    readonly externalCloneUrl: string;
    readonly externalToken: string;
    readonly defaultBranch: string;
    readonly operationKey: string;
  }): Promise<{ readonly internalHeadSha: string; readonly externalHeadSha: string }>;
}

export class GitHubExportNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super('GitHub export target does not exist');
    this.name = 'GitHubExportNotFoundError';
  }
}

export class GitHubExportConflictError extends Error {
  readonly statusCode = 409;

  constructor(readonly repositoryUrl: string) {
    super('Project already has a GitHub export');
    this.name = 'GitHubExportConflictError';
  }
}

function conflict(
  provider: GitHubExportProviderPort,
  externalRepoRef: string,
): GitHubExportConflictError {
  return new GitHubExportConflictError(
    z.string().url().parse(provider.repositoryUrl(externalRepoRef)),
  );
}

export function createGitHubExportService(input: {
  readonly store: GitHubExportStore;
  readonly provider: GitHubExportProviderPort;
  readonly git: GitHubExportGitPort;
}) {
  return {
    async exportProject(rawInput: z.input<typeof GitHubExportInputSchema>) {
      const request = GitHubExportInputSchema.parse(rawInput);
      const target = await input.store.resolve({
        organizationId: request.organizationId,
        projectId: request.projectId,
        installationId: request.installationId,
      });
      if (target === undefined) throw new GitHubExportNotFoundError();
      if (target.externalRepoRef !== null) {
        throw conflict(input.provider, target.externalRepoRef);
      }

      const created = CreatedGitHubRepositorySchema.parse(
        await input.provider.createRepository({
          installationId: request.installationId,
          operationKey: request.operationKey,
          name: request.repositoryName,
          private: request.private,
        }),
      );
      const pushed = PushedHistorySchema.parse(
        await input.git.pushFullHistory({
          internalRepoRef: target.internalRepoRef,
          externalCloneUrl: created.cloneUrl,
          externalToken: created.token,
          defaultBranch: target.defaultBranch,
          operationKey: request.operationKey,
        }),
      );
      if (pushed.internalHeadSha !== pushed.externalHeadSha) {
        throw new Error('GitHub export did not preserve the default-branch head');
      }

      const completed = CompleteGitHubExportResultSchema.parse(
        await input.store.complete({
          target,
          installationId: request.installationId,
          externalRepoRef: created.fullName,
          syncPolicy: request.syncPolicy,
        }),
      );
      if (completed.status === 'not_found') throw new GitHubExportNotFoundError();
      if (completed.status === 'conflict') {
        throw conflict(input.provider, completed.externalRepoRef);
      }
      return GitHubExportResultSchema.parse({
        externalRepoRef: created.fullName,
        repositoryUrl: created.repositoryUrl,
        syncPolicy: request.syncPolicy,
        ...pushed,
      });
    },
  };
}

export function createDbGitHubExportStore(database: Database): GitHubExportStore {
  async function installationExists(input: {
    readonly executor: Executor;
    readonly organizationId: string;
    readonly installationId: string;
  }): Promise<boolean> {
    const [row] = await input.executor
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.organizationId, input.organizationId),
          eq(integrationConnections.provider, 'github'),
          isNull(integrationConnections.projectId),
          sql`${integrationConnections.configurationJson} ->> 'installationId' = ${input.installationId}`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  return {
    async resolve(rawInput) {
      const request = GitHubExportInputSchema.pick({
        organizationId: true,
        projectId: true,
        installationId: true,
      }).parse(rawInput);
      if (
        !(await installationExists({
          executor: database,
          organizationId: request.organizationId,
          installationId: request.installationId,
        }))
      ) {
        return undefined;
      }
      const [row] = await database
        .select({
          organizationId: repositories.organizationId,
          projectId: repositories.projectId,
          internalRepoRef: repositories.internalRepoRef,
          defaultBranch: repositories.defaultBranch,
          externalRepoRef: repositories.externalRepoRef,
          sourceType: projects.sourceType,
        })
        .from(repositories)
        .innerJoin(
          projects,
          and(
            eq(projects.id, repositories.projectId),
            eq(projects.organizationId, repositories.organizationId),
          ),
        )
        .where(
          and(
            eq(repositories.organizationId, request.organizationId),
            eq(repositories.projectId, request.projectId),
          ),
        )
        .limit(1);
      if (row === undefined || row.sourceType === 'github_import') return undefined;
      return GitHubExportTargetSchema.parse({
        organizationId: row.organizationId,
        projectId: row.projectId,
        internalRepoRef: row.internalRepoRef,
        defaultBranch: row.defaultBranch,
        externalRepoRef: row.externalRepoRef,
      });
    },

    async complete(rawInput) {
      const completed = CompleteGitHubExportInputSchema.parse(rawInput);
      return await database.transaction(async (tx) => {
        const authorized = await installationExists({
          executor: tx,
          organizationId: completed.target.organizationId,
          installationId: completed.installationId,
        });
        if (!authorized) return { status: 'not_found' as const };
        const [current] = await tx
          .select({ externalRepoRef: repositories.externalRepoRef })
          .from(repositories)
          .where(
            and(
              eq(repositories.organizationId, completed.target.organizationId),
              eq(repositories.projectId, completed.target.projectId),
            ),
          )
          .for('update')
          .limit(1);
        if (current === undefined) return { status: 'not_found' as const };
        if (current.externalRepoRef !== null) {
          return CompleteGitHubExportResultSchema.parse({
            status: 'conflict',
            externalRepoRef: current.externalRepoRef,
          });
        }
        await tx
          .update(repositories)
          .set({
            externalRepoRef: completed.externalRepoRef,
            syncPolicy: completed.syncPolicy,
          })
          .where(
            and(
              eq(repositories.organizationId, completed.target.organizationId),
              eq(repositories.projectId, completed.target.projectId),
            ),
          );
        return { status: 'linked' as const };
      });
    },
  };
}
