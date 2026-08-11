import { CommitShaSchema, idSchema, newId } from '@zapp/contracts';
import {
  agentEvents,
  agentPhases,
  agentRuns,
  agentTasks,
  branches,
  githubImports,
  integrationConnections,
  nextEventSequence,
  repositories,
  type Database,
  type Executor,
} from '@zapp/db';
import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { z } from 'zod';

import { GitHubRepositoryFullNameSchema, GitHubWebhookQueueMessageSchema } from './schemas.js';

export const GitHubSyncPolicySchema = z.enum(['direct_push', 'pull_request']);
export const GitHubSyncRelationSchema = z.enum(['in_sync', 'ahead', 'behind', 'diverged']);

const BranchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !value.startsWith('/') && !value.endsWith('/') && !value.includes('..'))
  .refine((value) => !/[\u0000-\u0020~^:?*\\[]/u.test(value));

const GitHubPushPayloadSchema = z
  .object({
    ref: z.string().regex(/^refs\/heads\/.+/u),
    after: CommitShaSchema,
    deleted: z.boolean().default(false),
    repository: z.object({ full_name: GitHubRepositoryFullNameSchema }).passthrough(),
    installation: z
      .object({ id: z.union([z.string().min(1), z.number().int().positive()]) })
      .passthrough(),
  })
  .passthrough();

export const GitHubSyncTargetSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    installationId: z.string().min(1),
    internalRepoRef: z.string().min(1),
    externalRepoRef: GitHubRepositoryFullNameSchema,
    branchId: idSchema('br'),
    branch: BranchNameSchema,
    syncPolicy: GitHubSyncPolicySchema,
    previousExternalHeadSha: CommitShaSchema,
  })
  .strict();

export type GitHubSyncTarget = z.infer<typeof GitHubSyncTargetSchema>;
export type GitHubSyncRelation = z.infer<typeof GitHubSyncRelationSchema>;

export const GitHubSyncStateSchema = z
  .object({
    projectId: idSchema('proj'),
    branch: BranchNameSchema,
    internalHeadSha: CommitShaSchema,
    externalHeadSha: CommitShaSchema,
    state: GitHubSyncRelationSchema,
  })
  .strict();
export type GitHubSyncState = z.infer<typeof GitHubSyncStateSchema>;

const PreparedRepositorySchema = z
  .object({
    cloneUrl: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//u.test(value), 'cloneUrl must use HTTP(S)'),
    token: z.string().min(1),
  })
  .strict();

const PullRequestResultSchema = z
  .object({ number: z.number().int().positive(), url: z.string().url() })
  .strict();

export interface GitHubSyncProviderPort {
  prepareRepository(input: {
    readonly installationId: string;
    readonly externalRepoRef: string;
  }): Promise<{ readonly cloneUrl: string; readonly token: string }>;
  openPullRequest(input: {
    readonly installationId: string;
    readonly externalRepoRef: string;
    readonly head: string;
    readonly base: string;
    readonly title: string;
  }): Promise<{ readonly number: number; readonly url: string }>;
}

export interface GitHubSyncGitPort {
  fetchExternal(input: {
    readonly internalRepoRef: string;
    readonly externalCloneUrl: string;
    readonly externalToken: string;
    readonly branch: string;
  }): Promise<{
    readonly internalHeadSha: string;
    readonly externalHeadSha: string;
    readonly state: GitHubSyncRelation;
  }>;
  /**
   * Deliberately has no `force` argument. A non-fast-forward update is a Git
   * conflict, never a policy option this caller can switch on.
   */
  pushExternal(input: {
    readonly internalRepoRef: string;
    readonly externalCloneUrl: string;
    readonly externalToken: string;
    readonly sourceBranch: string;
    readonly targetBranch: string;
  }): Promise<{ readonly internalHeadSha: string; readonly externalHeadSha: string }>;
}

export interface RecordInboundSyncInput {
  readonly target: GitHubSyncTarget;
  readonly deliveryId: string;
  readonly webhookHeadSha: string;
  readonly previousExternalHeadSha: string;
  readonly internalHeadSha: string;
  readonly externalHeadSha: string;
  readonly state: GitHubSyncRelation;
  readonly now: Date;
}

export interface RecordOutboundSyncInput {
  readonly target: GitHubSyncTarget;
  readonly runId: string;
  readonly action: 'direct_push' | 'pull_request';
  readonly head: string;
  readonly internalHeadSha: string;
  readonly externalHeadSha: string;
  readonly now: Date;
}

export interface GitHubSyncStore {
  resolveInbound(input: {
    readonly installationId: string;
    readonly externalRepoRef: string;
    readonly branch: string;
  }): Promise<GitHubSyncTarget | undefined>;
  resolveOutbound(input: {
    readonly organizationId: string;
    readonly projectId: string;
  }): Promise<GitHubSyncTarget | undefined>;
  recordInbound(input: RecordInboundSyncInput): Promise<{
    readonly blockedTaskIds: readonly string[];
    readonly conflictCreated: boolean;
  }>;
  recordOutbound(input: RecordOutboundSyncInput): Promise<void>;
}

const ACTIVE_TASK_STATES = [
  'queued',
  'ready',
  'running',
  'waiting_for_approval',
  'verifying',
  'repairing',
] as const;

const DbSyncConfigurationSchema = z
  .object({
    installationId: z.string().min(1),
    externalRepoRef: GitHubRepositoryFullNameSchema,
    branch: BranchNameSchema,
    internalHeadSha: CommitShaSchema,
    externalHeadSha: CommitShaSchema,
    state: GitHubSyncRelationSchema,
    lastDeliveryId: z.string().min(1).nullable(),
    blockedTaskIds: z.array(idSchema('task')),
    conflictTaskId: idSchema('task').nullable(),
    conflictCreated: z.boolean(),
    updatedAt: z.string().datetime(),
  })
  .strict();
type DbSyncConfiguration = z.infer<typeof DbSyncConfigurationSchema>;

interface DbTargetRow {
  readonly organizationId: string;
  readonly projectId: string;
  readonly installationId: string;
  readonly internalRepoRef: string;
  readonly externalRepoRef: string | null;
  readonly branchId: string;
  readonly branch: string;
  readonly internalHeadSha: string | null;
  readonly syncPolicy: string;
}

async function projectSyncConfiguration(
  database: Executor,
  projectId: string,
): Promise<{ readonly id: string; readonly value: DbSyncConfiguration } | undefined> {
  const [row] = await database
    .select({
      id: integrationConnections.id,
      configuration: integrationConnections.configurationJson,
    })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.projectId, projectId),
        eq(integrationConnections.provider, 'github'),
      ),
    )
    .limit(1);
  if (row === undefined) return undefined;
  return { id: row.id, value: DbSyncConfigurationSchema.parse(row.configuration) };
}

async function targetFromRow(
  database: Executor,
  row: DbTargetRow | undefined,
): Promise<GitHubSyncTarget | undefined> {
  if (row === undefined || row.externalRepoRef === null || row.internalHeadSha === null) {
    return undefined;
  }
  const syncPolicy = GitHubSyncPolicySchema.safeParse(row.syncPolicy);
  if (!syncPolicy.success) return undefined;
  const recorded = await projectSyncConfiguration(database, row.projectId);
  const previousExternalHeadSha =
    recorded?.value.branch === row.branch
      ? recorded.value.externalHeadSha
      : CommitShaSchema.parse(row.internalHeadSha);
  return GitHubSyncTargetSchema.parse({
    organizationId: row.organizationId,
    projectId: row.projectId,
    installationId: row.installationId,
    internalRepoRef: row.internalRepoRef,
    externalRepoRef: row.externalRepoRef,
    branchId: row.branchId,
    branch: row.branch,
    syncPolicy: syncPolicy.data,
    previousExternalHeadSha,
  });
}

function configurationFor(input: {
  readonly target: GitHubSyncTarget;
  readonly internalHeadSha: string;
  readonly externalHeadSha: string;
  readonly state: GitHubSyncRelation;
  readonly lastDeliveryId: string | null;
  readonly blockedTaskIds: readonly string[];
  readonly conflictTaskId: string | null;
  readonly conflictCreated: boolean;
  readonly now: Date;
}): DbSyncConfiguration {
  return DbSyncConfigurationSchema.parse({
    installationId: input.target.installationId,
    externalRepoRef: input.target.externalRepoRef,
    branch: input.target.branch,
    internalHeadSha: input.internalHeadSha,
    externalHeadSha: input.externalHeadSha,
    state: input.state,
    lastDeliveryId: input.lastDeliveryId,
    blockedTaskIds: input.blockedTaskIds,
    conflictTaskId: input.conflictTaskId,
    conflictCreated: input.conflictCreated,
    updatedAt: input.now.toISOString(),
  });
}

/**
 * Durable INT-3 state. The repository row is the per-project serialization
 * lock, so duplicate webhook deliveries cannot create duplicate conflict tasks
 * even when separate control-api replicas receive them concurrently.
 */
export function createDbGitHubSyncStore(database: Database): GitHubSyncStore {
  return {
    async resolveInbound(input) {
      const [row] = await database
        .select({
          organizationId: repositories.organizationId,
          projectId: repositories.projectId,
          installationId: githubImports.installationId,
          internalRepoRef: repositories.internalRepoRef,
          externalRepoRef: repositories.externalRepoRef,
          branchId: branches.id,
          branch: branches.name,
          internalHeadSha: branches.headCommitSha,
          syncPolicy: repositories.syncPolicy,
        })
        .from(repositories)
        .innerJoin(githubImports, eq(githubImports.projectId, repositories.projectId))
        .innerJoin(
          branches,
          and(eq(branches.projectId, repositories.projectId), eq(branches.name, input.branch)),
        )
        .where(
          and(
            eq(repositories.externalRepoRef, input.externalRepoRef),
            eq(githubImports.installationId, input.installationId),
          ),
        )
        .limit(1);
      return await targetFromRow(database, row);
    },

    async resolveOutbound(input) {
      const [row] = await database
        .select({
          organizationId: repositories.organizationId,
          projectId: repositories.projectId,
          installationId: githubImports.installationId,
          internalRepoRef: repositories.internalRepoRef,
          externalRepoRef: repositories.externalRepoRef,
          branchId: branches.id,
          branch: branches.name,
          internalHeadSha: branches.headCommitSha,
          syncPolicy: repositories.syncPolicy,
        })
        .from(repositories)
        .innerJoin(githubImports, eq(githubImports.projectId, repositories.projectId))
        .innerJoin(
          branches,
          and(
            eq(branches.projectId, repositories.projectId),
            eq(branches.name, repositories.defaultBranch),
          ),
        )
        .where(
          and(
            eq(repositories.organizationId, input.organizationId),
            eq(repositories.projectId, input.projectId),
          ),
        )
        .limit(1);
      return await targetFromRow(database, row);
    },

    async recordInbound(sync) {
      return await database.transaction(async (tx) => {
        await tx
          .select({ id: repositories.id })
          .from(repositories)
          .where(
            and(
              eq(repositories.organizationId, sync.target.organizationId),
              eq(repositories.projectId, sync.target.projectId),
            ),
          )
          .for('update');
        const current = await projectSyncConfiguration(tx, sync.target.projectId);
        if (current?.value.lastDeliveryId === sync.deliveryId) {
          return {
            blockedTaskIds: current.value.blockedTaskIds,
            conflictCreated: current.value.conflictCreated,
          };
        }

        const externalMoved = sync.previousExternalHeadSha !== sync.externalHeadSha;
        const staleTasks = externalMoved
          ? await tx
              .select({
                id: agentTasks.id,
                phaseId: agentTasks.phaseId,
                runId: agentRuns.id,
                baseCommitSha: agentTasks.baseCommitSha,
              })
              .from(agentTasks)
              .innerJoin(agentPhases, eq(agentPhases.id, agentTasks.phaseId))
              .innerJoin(agentRuns, eq(agentRuns.id, agentPhases.runId))
              .where(
                and(
                  eq(agentRuns.organizationId, sync.target.organizationId),
                  eq(agentRuns.projectId, sync.target.projectId),
                  eq(agentRuns.branchId, sync.target.branchId),
                  inArray(agentTasks.status, ACTIVE_TASK_STATES),
                  isNotNull(agentTasks.baseCommitSha),
                  ne(agentTasks.baseCommitSha, sync.externalHeadSha),
                ),
              )
              .for('update')
          : [];
        const blockedTaskIds = staleTasks.map((task) => task.id);
        if (blockedTaskIds.length > 0) {
          await tx
            .update(agentTasks)
            .set({ status: 'blocked' })
            .where(inArray(agentTasks.id, blockedTaskIds));
        }
        for (const task of staleTasks) {
          await tx.insert(agentEvents).values({
            id: newId('evt'),
            organizationId: sync.target.organizationId,
            projectId: sync.target.projectId,
            runId: task.runId,
            phaseId: task.phaseId,
            taskId: task.id,
            agentId: null,
            sequence: await nextEventSequence(tx, task.runId),
            type: 'task.blocked',
            payloadJson: {
              reason: 'stale_git_base',
              baseCommitSha: task.baseCommitSha,
              internalHeadSha: sync.internalHeadSha,
              externalHeadSha: sync.externalHeadSha,
              deliveryId: sync.deliveryId,
            },
            visibility: 'user',
            occurredAt: sync.now,
          });
        }

        let conflictTaskId =
          current?.value.state === 'diverged' &&
          current.value.internalHeadSha === sync.internalHeadSha &&
          current.value.externalHeadSha === sync.externalHeadSha
            ? current.value.conflictTaskId
            : null;
        let conflictCreated = false;
        if (sync.state === 'diverged' && conflictTaskId === null) {
          const phase =
            staleTasks[0] ??
            (
              await tx
                .select({ phaseId: agentPhases.id, runId: agentRuns.id })
                .from(agentPhases)
                .innerJoin(agentRuns, eq(agentRuns.id, agentPhases.runId))
                .where(
                  and(
                    eq(agentRuns.organizationId, sync.target.organizationId),
                    eq(agentRuns.projectId, sync.target.projectId),
                    eq(agentRuns.branchId, sync.target.branchId),
                  ),
                )
                .orderBy(desc(agentRuns.startedAt), desc(agentPhases.sequence))
                .limit(1)
            )[0];
          if (phase !== undefined) {
            conflictTaskId = newId('task');
            await tx.insert(agentTasks).values({
              id: conflictTaskId,
              organizationId: sync.target.organizationId,
              phaseId: phase.phaseId,
              parentTaskId: null,
              title: 'Resolve GitHub divergence',
              status: 'blocked',
              riskLevel: 'medium',
              baseCommitSha: sync.internalHeadSha,
              outputCommitSha: null,
              acceptanceCriteriaJson: [
                `Preserve internal ${sync.internalHeadSha} and GitHub ${sync.externalHeadSha} until the user chooses a merge workflow.`,
              ],
              dependenciesJson: [],
              assignedAgentRole: null,
            });
            for (const type of ['task.created', 'task.blocked'] as const) {
              await tx.insert(agentEvents).values({
                id: newId('evt'),
                organizationId: sync.target.organizationId,
                projectId: sync.target.projectId,
                runId: phase.runId,
                phaseId: phase.phaseId,
                taskId: conflictTaskId,
                agentId: null,
                sequence: await nextEventSequence(tx, phase.runId),
                type,
                payloadJson: {
                  reason: 'github_diverged',
                  internalHeadSha: sync.internalHeadSha,
                  externalHeadSha: sync.externalHeadSha,
                  deliveryId: sync.deliveryId,
                },
                visibility: 'user',
                occurredAt: sync.now,
              });
            }
            conflictCreated = true;
          }
        }

        const configuration = configurationFor({
          target: sync.target,
          internalHeadSha: sync.internalHeadSha,
          externalHeadSha: sync.externalHeadSha,
          state: sync.state,
          lastDeliveryId: sync.deliveryId,
          blockedTaskIds,
          conflictTaskId,
          conflictCreated,
          now: sync.now,
        });
        if (current === undefined) {
          await tx.insert(integrationConnections).values({
            id: newId('intc'),
            organizationId: sync.target.organizationId,
            projectId: sync.target.projectId,
            provider: 'github',
            status: 'connected',
            credentialRef: null,
            configurationJson: configuration,
          });
        } else {
          await tx
            .update(integrationConnections)
            .set({ configurationJson: configuration })
            .where(eq(integrationConnections.id, current.id));
        }
        return { blockedTaskIds, conflictCreated };
      });
    },

    async recordOutbound(sync) {
      await database.transaction(async (tx) => {
        await tx
          .select({ id: repositories.id })
          .from(repositories)
          .where(
            and(
              eq(repositories.organizationId, sync.target.organizationId),
              eq(repositories.projectId, sync.target.projectId),
            ),
          )
          .for('update');
        const current = await projectSyncConfiguration(tx, sync.target.projectId);
        const isDefaultBranch = sync.head === sync.target.branch;
        if (isDefaultBranch) {
          await tx
            .update(branches)
            .set({ headCommitSha: sync.internalHeadSha })
            .where(
              and(
                eq(branches.projectId, sync.target.projectId),
                eq(branches.name, sync.target.branch),
              ),
            );
        }
        const configuration = configurationFor({
          target: sync.target,
          internalHeadSha: sync.internalHeadSha,
          externalHeadSha: sync.externalHeadSha,
          state: isDefaultBranch ? 'in_sync' : (current?.value.state ?? 'ahead'),
          lastDeliveryId: current?.value.lastDeliveryId ?? null,
          blockedTaskIds: current?.value.blockedTaskIds ?? [],
          conflictTaskId: isDefaultBranch ? null : (current?.value.conflictTaskId ?? null),
          conflictCreated: false,
          now: sync.now,
        });
        if (current === undefined) {
          await tx.insert(integrationConnections).values({
            id: newId('intc'),
            organizationId: sync.target.organizationId,
            projectId: sync.target.projectId,
            provider: 'github',
            status: 'connected',
            credentialRef: null,
            configurationJson: configuration,
          });
        } else {
          await tx
            .update(integrationConnections)
            .set({ configurationJson: configuration })
            .where(eq(integrationConnections.id, current.id));
        }
      });
    },
  };
}

const SyncCommitInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    runId: idSchema('run'),
    sourceBranch: BranchNameSchema,
  })
  .strict();

const InboundResultSchema = z
  .object({
    action: z.literal('inbound'),
    state: GitHubSyncRelationSchema,
    internalHeadSha: CommitShaSchema,
    externalHeadSha: CommitShaSchema,
    blockedTaskIds: z.array(idSchema('task')),
    conflictCreated: z.boolean(),
  })
  .strict();

const IgnoredResultSchema = z.object({ action: z.literal('ignored') }).strict();

const OutboundResultSchema = z
  .object({
    action: GitHubSyncPolicySchema,
    head: BranchNameSchema,
    internalHeadSha: CommitShaSchema,
    externalHeadSha: CommitShaSchema,
    pullRequest: PullRequestResultSchema.optional(),
  })
  .strict();

function branchOf(ref: string): string {
  return BranchNameSchema.parse(ref.slice('refs/heads/'.length));
}

export function createGitHubSyncEngine(input: {
  readonly store: GitHubSyncStore;
  readonly provider: GitHubSyncProviderPort;
  readonly git: GitHubSyncGitPort;
  readonly now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  return {
    async processWebhook(body: string) {
      const message = GitHubWebhookQueueMessageSchema.parse(JSON.parse(body) as unknown);
      if (message.eventName !== 'push' || message.installationId === undefined) {
        return IgnoredResultSchema.parse({ action: 'ignored' });
      }
      const payload = GitHubPushPayloadSchema.parse(message.payload);
      if (payload.deleted) return IgnoredResultSchema.parse({ action: 'ignored' });
      if (String(payload.installation.id) !== message.installationId) {
        throw new Error('GitHub delivery installation does not match its queue attribution');
      }
      const branch = branchOf(payload.ref);
      const target = await input.store.resolveInbound({
        installationId: message.installationId,
        externalRepoRef: payload.repository.full_name,
        branch,
      });
      if (target === undefined) return IgnoredResultSchema.parse({ action: 'ignored' });
      const prepared = PreparedRepositorySchema.parse(
        await input.provider.prepareRepository({
          installationId: target.installationId,
          externalRepoRef: target.externalRepoRef,
        }),
      );
      const comparison = z
        .object({
          internalHeadSha: CommitShaSchema,
          externalHeadSha: CommitShaSchema,
          state: GitHubSyncRelationSchema,
        })
        .strict()
        .parse(
          await input.git.fetchExternal({
            internalRepoRef: target.internalRepoRef,
            externalCloneUrl: prepared.cloneUrl,
            externalToken: prepared.token,
            branch,
          }),
        );
      const recorded = await input.store.recordInbound({
        target,
        deliveryId: message.deliveryId,
        webhookHeadSha: payload.after,
        previousExternalHeadSha: target.previousExternalHeadSha,
        ...comparison,
        now: now(),
      });
      return InboundResultSchema.parse({ action: 'inbound', ...comparison, ...recorded });
    },

    async syncCommit(rawInput: z.input<typeof SyncCommitInputSchema>) {
      const syncInput = SyncCommitInputSchema.parse(rawInput);
      const target = await input.store.resolveOutbound(syncInput);
      if (target === undefined) throw new Error('GitHub synchronization target does not exist');
      const prepared = PreparedRepositorySchema.parse(
        await input.provider.prepareRepository({
          installationId: target.installationId,
          externalRepoRef: target.externalRepoRef,
        }),
      );
      const head =
        target.syncPolicy === 'direct_push' ? target.branch : `zapp/run-${syncInput.runId}`;
      const pushed = z
        .object({ internalHeadSha: CommitShaSchema, externalHeadSha: CommitShaSchema })
        .strict()
        .parse(
          await input.git.pushExternal({
            internalRepoRef: target.internalRepoRef,
            externalCloneUrl: prepared.cloneUrl,
            externalToken: prepared.token,
            sourceBranch: syncInput.sourceBranch,
            targetBranch: head,
          }),
        );
      const pullRequest =
        target.syncPolicy === 'pull_request'
          ? PullRequestResultSchema.parse(
              await input.provider.openPullRequest({
                installationId: target.installationId,
                externalRepoRef: target.externalRepoRef,
                head,
                base: target.branch,
                title: `zapp.build run ${syncInput.runId}`,
              }),
            )
          : undefined;
      await input.store.recordOutbound({
        target,
        runId: syncInput.runId,
        action: target.syncPolicy,
        head,
        ...pushed,
        now: now(),
      });
      return OutboundResultSchema.parse({
        action: target.syncPolicy,
        head,
        ...pushed,
        ...(pullRequest === undefined ? {} : { pullRequest }),
      });
    },
  };
}
