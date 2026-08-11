import { createHash, randomUUID } from 'node:crypto';

import {
  activityIdempotency,
  agentEvents,
  agentRuns,
  auditEvents,
  environments,
  memberships,
  organizations,
  projects,
  releases,
  specifications,
  type Database,
  type Transaction,
} from '@zapp/db';
import { CommitShaSchema, idSchema, newId } from '@zapp/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

export const ReleaseStatusSchema = z.enum([
  'candidate',
  'verifying',
  'ready',
  'warnings',
  'blocked',
  'approved',
  'deploying',
  'healthy',
  'failed',
  'superseded',
]);
export type ReleaseStatus = z.infer<typeof ReleaseStatusSchema>;

const PersistedDateSchema = z.preprocess(
  (value) => (typeof value === 'string' ? new Date(value) : value),
  z.date(),
);

export const ReleaseSchema = z
  .object({
    id: idSchema('rel'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    commitSha: CommitShaSchema,
    specificationId: idSchema('spec').nullable(),
    status: ReleaseStatusSchema,
    evidenceManifestArtifactId: idSchema('art').nullable(),
    createdBy: idSchema('user'),
    createdAt: PersistedDateSchema,
  })
  .strict();
export type Release = z.infer<typeof ReleaseSchema>;

const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);
export const SpecificationWaiverSchema = z
  .object({
    reason: z.string().trim().min(1).max(2_000),
    approvedBy: idSchema('user'),
  })
  .strict();
export type SpecificationWaiver = z.infer<typeof SpecificationWaiverSchema>;

export const CreateReleaseCandidateInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    commitSha: CommitShaSchema,
    specificationId: idSchema('spec').nullable(),
    specificationWaiver: SpecificationWaiverSchema.optional(),
    actorId: idSchema('user'),
    operationKey: OperationKeySchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.specificationId === null && input.specificationWaiver === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A specification waiver is required when specificationId is null.',
        path: ['specificationWaiver'],
      });
    }
    if (input.specificationId !== null && input.specificationWaiver !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A specification and a waiver cannot both be supplied.',
        path: ['specificationWaiver'],
      });
    }
  });
export type CreateReleaseCandidateInput = z.infer<typeof CreateReleaseCandidateInputSchema>;

export const ActorSchema = z
  .object({
    id: idSchema('user'),
    organizationId: idSchema('org'),
  })
  .strict();
export type Actor = z.infer<typeof ActorSchema>;

const TransitionInputSchema = z
  .object({
    organizationId: idSchema('org'),
    releaseId: idSchema('rel'),
    to: ReleaseStatusSchema,
    operationKey: OperationKeySchema,
  })
  .strict();
export type TransitionInput = z.infer<typeof TransitionInputSchema>;

const ApproveInputSchema = z
  .object({
    releaseId: idSchema('rel'),
    actor: ActorSchema,
    operationKey: OperationKeySchema,
  })
  .strict();
export type ApproveInput = z.infer<typeof ApproveInputSchema>;

export interface ReadinessReport {
  readonly state: 'ready' | 'warnings' | 'blocked';
  readonly findings: readonly unknown[];
}

export type DeploymentType = 'first_deploy' | 'redeploy' | 'replace_deployment';
export interface DeploymentConfirmation {
  readonly dataDisposition: 'preserve' | 'transfer' | 'reset' | null;
}
export interface EvidenceManifest {
  readonly releaseId: string;
  readonly commitSha: string;
  readonly [section: string]: unknown;
}

/** Plan 07's six lifecycle operations. Later DEP tasks provide the non-record stages. */
export interface ReleasePort {
  createReleaseCandidate(input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly commitSha: string;
    readonly specificationId: string;
  }): Promise<Release>;
  getReadiness(releaseId: string): Promise<ReadinessReport>;
  approve(releaseId: string, actor: Actor): Promise<Release>;
  deploy(
    releaseId: string,
    input: {
      readonly deploymentType: DeploymentType;
      readonly confirmation: DeploymentConfirmation;
    },
  ): Promise<{ readonly deploymentId: string }>;
  rollback(input: {
    readonly environmentId: string;
    readonly toDeploymentId?: string;
    readonly reason: string;
  }): Promise<{ readonly deploymentId: string }>;
  getEvidence(releaseId: string): Promise<EvidenceManifest>;
}

export interface ReleaseGitPort {
  getCommit(input: { readonly projectId: string; readonly sha: string }): Promise<boolean>;
  createTag(input: {
    readonly projectId: string;
    readonly tag: string;
    readonly sha: string;
  }): Promise<void>;
}

export interface CandidateContext {
  readonly actorRole: 'owner' | 'builder' | 'viewer';
  readonly prototypeOnly: boolean;
  readonly waiverApproved: boolean;
}

export interface ReleaseContextPort {
  resolveCandidate(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly specificationId: string | null;
    readonly waiverApprovedBy: string | null;
    readonly actorId: string;
    readonly commitSha: string;
  }): Promise<CandidateContext | undefined>;
  canApprove(input: {
    readonly organizationId: string;
    readonly actorId: string;
  }): Promise<boolean>;
}

export interface CreateCandidateStoreInput {
  readonly operationKey: string;
  readonly fingerprint: string;
  readonly release: Release;
  readonly specificationWaiver?: SpecificationWaiver;
}

export interface TransitionStoreInput {
  readonly organizationId: string;
  readonly releaseId: string;
  readonly from: ReleaseStatus;
  readonly to: ReleaseStatus;
  readonly operationKey: string;
  readonly fingerprint: string;
}

export interface ReleaseStore {
  createCandidate(input: CreateCandidateStoreInput): Promise<Release>;
  get(organizationId: string, releaseId: string): Promise<Release | undefined>;
  getTransitionReplay(input: {
    readonly operationKey: string;
    readonly fingerprint: string;
  }): Promise<Release | undefined>;
  transition(input: TransitionStoreInput): Promise<Release>;
}

export type ReleaseErrorCode =
  | 'commit_not_found'
  | 'forbidden'
  | 'idempotency_conflict'
  | 'invalid_release_transition'
  | 'operation_in_progress'
  | 'prototype_not_deployable'
  | 'release_context_not_found'
  | 'release_not_found'
  | 'release_transition_conflict';

export class ReleaseServiceError extends Error {
  constructor(
    readonly code: ReleaseErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ReleaseServiceError';
  }
}

const ALLOWED_TRANSITIONS = {
  candidate: ['verifying'],
  verifying: ['ready', 'warnings', 'blocked'],
  ready: ['approved'],
  warnings: ['approved'],
  blocked: [],
  approved: ['deploying'],
  deploying: ['healthy', 'failed'],
  healthy: ['superseded'],
  failed: [],
  superseded: [],
} as const satisfies Record<ReleaseStatus, readonly ReleaseStatus[]>;

const OrganizationDeploySettingsSchema = z
  .object({ builderCanDeploy: z.boolean().default(false) })
  .passthrough();

/** Authoritative tenant, provenance, membership, and deploy-policy reads. */
export function createPostgresReleaseContext(database: Database): ReleaseContextPort {
  return {
    async resolveCandidate(input) {
      const specificationPromise =
        input.specificationId === null
          ? Promise.resolve(true)
          : database
              .select({ id: specifications.id })
              .from(specifications)
              .where(
                and(
                  eq(specifications.id, input.specificationId),
                  eq(specifications.organizationId, input.organizationId),
                  eq(specifications.projectId, input.projectId),
                ),
              )
              .limit(1)
              .then((rows) => rows.length === 1);
      const waiverApproverPromise =
        input.waiverApprovedBy === null
          ? Promise.resolve(true)
          : database
              .select({ role: memberships.role })
              .from(memberships)
              .where(
                and(
                  eq(memberships.organizationId, input.organizationId),
                  eq(memberships.userId, input.waiverApprovedBy),
                  eq(memberships.status, 'active'),
                ),
              )
              .limit(1)
              .then((rows) => rows[0]?.role === 'owner');
      const [projectRows, environmentRows, actorRows, specificationExists, waiverApproved, modes] =
        await Promise.all([
          database
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.id, input.projectId),
                eq(projects.organizationId, input.organizationId),
              ),
            )
            .limit(1),
          database
            .select({ id: environments.id })
            .from(environments)
            .where(
              and(
                eq(environments.id, input.environmentId),
                eq(environments.organizationId, input.organizationId),
                eq(environments.projectId, input.projectId),
              ),
            )
            .limit(1),
          database
            .select({ role: memberships.role })
            .from(memberships)
            .where(
              and(
                eq(memberships.organizationId, input.organizationId),
                eq(memberships.userId, input.actorId),
                eq(memberships.status, 'active'),
              ),
            )
            .limit(1),
          specificationPromise,
          waiverApproverPromise,
          database
            .select({ mode: agentRuns.mode })
            .from(agentRuns)
            .innerJoin(agentEvents, eq(agentEvents.runId, agentRuns.id))
            .where(
              and(
                eq(agentRuns.organizationId, input.organizationId),
                eq(agentRuns.projectId, input.projectId),
                eq(agentEvents.organizationId, input.organizationId),
                eq(agentEvents.projectId, input.projectId),
                eq(agentEvents.type, 'commit.created'),
                sql`${agentEvents.payloadJson}->>'commitSha' = ${input.commitSha}`,
              ),
            ),
        ]);
      const actorRole = actorRows[0]?.role;
      if (
        projectRows.length !== 1 ||
        environmentRows.length !== 1 ||
        actorRole === undefined ||
        !specificationExists
      ) {
        return undefined;
      }
      const runModes = new Set(modes.map((row) => row.mode));
      return {
        actorRole,
        prototypeOnly: runModes.has('prototype') && !runModes.has('build'),
        waiverApproved,
      };
    },

    async canApprove(input) {
      const [membershipRows, organizationRows] = await Promise.all([
        database
          .select({ role: memberships.role })
          .from(memberships)
          .where(
            and(
              eq(memberships.organizationId, input.organizationId),
              eq(memberships.userId, input.actorId),
              eq(memberships.status, 'active'),
            ),
          )
          .limit(1),
        database
          .select({ settings: organizations.settingsJson })
          .from(organizations)
          .where(eq(organizations.id, input.organizationId))
          .limit(1),
      ]);
      const role = membershipRows[0]?.role;
      if (role === 'owner') return true;
      if (role !== 'builder') return false;
      const settings = OrganizationDeploySettingsSchema.safeParse(
        organizationRows[0]?.settings,
      );
      return settings.success && settings.data.builderCanDeploy;
    },
  };
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

type OperationClaim = { readonly status: 'acquired' } | { readonly status: 'replay'; readonly release: Release };

async function claimOperation(
  transaction: Transaction,
  input: {
    readonly key: string;
    readonly type: string;
    readonly fingerprint: string;
    readonly ownerId: string;
  },
): Promise<OperationClaim> {
  const inserted = await transaction
    .insert(activityIdempotency)
    .values({
      idempotencyKey: input.key,
      activityType: input.type,
      inputHash: input.fingerprint,
      status: 'running',
      ownerId: input.ownerId,
      leaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'`,
    })
    .onConflictDoNothing()
    .returning({ key: activityIdempotency.idempotencyKey });
  if (inserted.length === 1) return { status: 'acquired' };

  const [row] = await transaction
    .select({
      type: activityIdempotency.activityType,
      fingerprint: activityIdempotency.inputHash,
      status: activityIdempotency.status,
      result: activityIdempotency.resultJson,
      expired: sql<boolean>`${activityIdempotency.leaseExpiresAt} <= clock_timestamp()`,
    })
    .from(activityIdempotency)
    .where(eq(activityIdempotency.idempotencyKey, input.key))
    .for('update');
  if (row === undefined) throw new Error('Release idempotency claim disappeared');
  if (row.type !== input.type || row.fingerprint !== input.fingerprint) {
    throw new ReleaseServiceError(
      'idempotency_conflict',
      409,
      'The operation key was already used for different input.',
    );
  }
  if (row.status === 'completed') {
    return { status: 'replay', release: ReleaseSchema.parse(row.result) };
  }
  if (!row.expired) {
    throw new ReleaseServiceError(
      'operation_in_progress',
      409,
      'The release operation is already in progress.',
    );
  }
  await transaction
    .update(activityIdempotency)
    .set({
      ownerId: input.ownerId,
      leaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(activityIdempotency.idempotencyKey, input.key));
  return { status: 'acquired' };
}

async function completeOperation(
  transaction: Transaction,
  key: string,
  ownerId: string,
  release: Release,
): Promise<void> {
  const updated = await transaction
    .update(activityIdempotency)
    .set({
      status: 'completed',
      ownerId: null,
      leaseExpiresAt: null,
      resultHash: hash(release),
      resultJson: release,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(activityIdempotency.idempotencyKey, key),
        eq(activityIdempotency.status, 'running'),
        eq(activityIdempotency.ownerId, ownerId),
      ),
    )
    .returning({ key: activityIdempotency.idempotencyKey });
  if (updated.length !== 1) throw new Error('Release idempotency ownership was lost');
}

async function completedOperation(
  database: Database,
  input: {
    readonly key: string;
    readonly type: string;
    readonly fingerprint: string;
  },
): Promise<Release | undefined> {
  const [row] = await database
    .select({
      type: activityIdempotency.activityType,
      fingerprint: activityIdempotency.inputHash,
      status: activityIdempotency.status,
      result: activityIdempotency.resultJson,
    })
    .from(activityIdempotency)
    .where(eq(activityIdempotency.idempotencyKey, input.key))
    .limit(1);
  if (row === undefined) return undefined;
  if (row.type !== input.type || row.fingerprint !== input.fingerprint) {
    throw new ReleaseServiceError(
      'idempotency_conflict',
      409,
      'The operation key was already used for different input.',
    );
  }
  return row.status === 'completed' ? ReleaseSchema.parse(row.result) : undefined;
}

export function createPostgresReleaseStore(database: Database): ReleaseStore {
  return {
    createCandidate(input) {
      const key = `release:create:${input.operationKey}`;
      const ownerId = randomUUID();
      return database.transaction(async (transaction) => {
        const claim = await claimOperation(transaction, {
          key,
          type: 'release.create',
          fingerprint: input.fingerprint,
          ownerId,
        });
        if (claim.status === 'replay') return claim.release;
        const [created] = await transaction
          .insert(releases)
          .values(input.release)
          .returning();
        const release = ReleaseSchema.parse(created);
        if (input.specificationWaiver !== undefined) {
          await transaction.insert(auditEvents).values({
            id: newId('aud'),
            organizationId: release.organizationId,
            actorType: 'user',
            actorId: input.specificationWaiver.approvedBy,
            action: 'release.specification_waived',
            targetType: 'release',
            targetId: release.id,
            metadataJson: {
              projectId: release.projectId,
              reason: input.specificationWaiver.reason,
            },
            occurredAt: release.createdAt,
          });
        }
        await completeOperation(transaction, key, ownerId, release);
        return release;
      });
    },

    async get(organizationId, releaseId) {
      const [row] = await database
        .select()
        .from(releases)
        .where(and(eq(releases.organizationId, organizationId), eq(releases.id, releaseId)))
        .limit(1);
      return row === undefined ? undefined : ReleaseSchema.parse(row);
    },

    getTransitionReplay(input) {
      return completedOperation(database, {
        key: `release:transition:${input.operationKey}`,
        type: 'release.transition',
        fingerprint: input.fingerprint,
      });
    },

    transition(input) {
      const key = `release:transition:${input.operationKey}`;
      const ownerId = randomUUID();
      return database.transaction(async (transaction) => {
        const claim = await claimOperation(transaction, {
          key,
          type: 'release.transition',
          fingerprint: input.fingerprint,
          ownerId,
        });
        if (claim.status === 'replay') return claim.release;
        if (input.from === input.to) {
          throw new ReleaseServiceError(
            'invalid_release_transition',
            409,
            `Release status ${input.from} cannot transition to ${input.to}.`,
          );
        }
        const [current] = await transaction
          .select()
          .from(releases)
          .where(
            and(
              eq(releases.organizationId, input.organizationId),
              eq(releases.id, input.releaseId),
            ),
          )
          .for('update');
        if (current === undefined) {
          throw new ReleaseServiceError('release_not_found', 404, 'Release not found.');
        }
        if (current.status !== input.from) {
          throw new ReleaseServiceError(
            'release_transition_conflict',
            409,
            'The release changed before this transition could be applied.',
          );
        }
        const [changed] = await transaction
          .update(releases)
          .set({ status: input.to })
          .where(
            and(
              eq(releases.organizationId, input.organizationId),
              eq(releases.id, input.releaseId),
              eq(releases.status, input.from),
            ),
          )
          .returning();
        if (changed === undefined) {
          throw new ReleaseServiceError(
            'release_transition_conflict',
            409,
            'The release changed before this transition could be applied.',
          );
        }
        const release = ReleaseSchema.parse(changed);
        await completeOperation(transaction, key, ownerId, release);
        return release;
      });
    },
  };
}

export interface ReleaseRecordService {
  createReleaseCandidate(input: CreateReleaseCandidateInput): Promise<Release>;
  getRelease(organizationId: string, releaseId: string): Promise<Release | undefined>;
  transitionStatus(input: TransitionInput): Promise<Release>;
  approve(input: ApproveInput): Promise<Release>;
}

export function createReleaseRecordService(dependencies: {
  readonly store: ReleaseStore;
  readonly git: ReleaseGitPort;
  readonly context: ReleaseContextPort;
  readonly newReleaseId?: () => string;
  readonly now?: () => Date;
}): ReleaseRecordService {
  const newReleaseId = dependencies.newReleaseId ?? (() => newId('rel'));
  const now = dependencies.now ?? (() => new Date());

  async function transitionStatus(untrustedInput: TransitionInput): Promise<Release> {
    const input = TransitionInputSchema.parse(untrustedInput);
    const fingerprint = hash(input);
    const replay = await dependencies.store.getTransitionReplay({
      operationKey: input.operationKey,
      fingerprint,
    });
    if (replay !== undefined) return replay;
    const current = await dependencies.store.get(input.organizationId, input.releaseId);
    if (current === undefined) {
      throw new ReleaseServiceError('release_not_found', 404, 'Release not found.');
    }
    if (!ALLOWED_TRANSITIONS[current.status].some((status) => status === input.to)) {
      throw new ReleaseServiceError(
        'invalid_release_transition',
        409,
        `Release status ${current.status} cannot transition to ${input.to}.`,
      );
    }
    return dependencies.store.transition({
      organizationId: input.organizationId,
      releaseId: input.releaseId,
      from: current.status,
      to: input.to,
      operationKey: input.operationKey,
      fingerprint,
    });
  }

  return {
    async createReleaseCandidate(untrustedInput) {
      const input = CreateReleaseCandidateInputSchema.parse(untrustedInput);
      const candidateContext = await dependencies.context.resolveCandidate({
        organizationId: input.organizationId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        specificationId: input.specificationId,
        waiverApprovedBy: input.specificationWaiver?.approvedBy ?? null,
        actorId: input.actorId,
        commitSha: input.commitSha,
      });
      if (candidateContext === undefined) {
        throw new ReleaseServiceError(
          'release_context_not_found',
          404,
          'The release candidate context was not found.',
        );
      }
      if (candidateContext.actorRole === 'viewer') {
        throw new ReleaseServiceError(
          'forbidden',
          403,
          'The actor may not create a release candidate.',
        );
      }
      if (input.specificationWaiver !== undefined && !candidateContext.waiverApproved) {
        throw new ReleaseServiceError(
          'forbidden',
          403,
          'The specification waiver requires an active Owner approval.',
        );
      }
      if (candidateContext.prototypeOnly) {
        throw new ReleaseServiceError(
          'prototype_not_deployable',
          409,
          'Prototype-only commits must be converted to Build before release creation.',
        );
      }
      if (!(await dependencies.git.getCommit({ projectId: input.projectId, sha: input.commitSha }))) {
        throw new ReleaseServiceError(
          'commit_not_found',
          422,
          'The requested commit does not exist in internal Git.',
        );
      }
      const fingerprint = hash(input);
      const created = await dependencies.store.createCandidate({
        operationKey: input.operationKey,
        fingerprint,
        ...(input.specificationWaiver === undefined
          ? {}
          : { specificationWaiver: input.specificationWaiver }),
        release: {
          id: idSchema('rel').parse(newReleaseId()),
          organizationId: input.organizationId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          commitSha: input.commitSha,
          specificationId: input.specificationId,
          status: 'candidate',
          evidenceManifestArtifactId: null,
          createdBy: input.actorId,
          createdAt: now(),
        },
      });
      await dependencies.git.createTag({
        projectId: created.projectId,
        tag: created.id,
        sha: created.commitSha,
      });
      return created;
    },

    getRelease(organizationId, releaseId) {
      return dependencies.store.get(idSchema('org').parse(organizationId), idSchema('rel').parse(releaseId));
    },

    transitionStatus,

    async approve(untrustedInput) {
      const input = ApproveInputSchema.parse(untrustedInput);
      const current = await dependencies.store.get(
        input.actor.organizationId,
        input.releaseId,
      );
      if (current === undefined) {
        throw new ReleaseServiceError('release_not_found', 404, 'Release not found.');
      }
      const mayApprove = await dependencies.context.canApprove({
        organizationId: input.actor.organizationId,
        actorId: input.actor.id,
      });
      if (!mayApprove) {
        throw new ReleaseServiceError(
          'forbidden',
          403,
          'The actor may not approve a production deployment.',
        );
      }
      return transitionStatus({
        organizationId: input.actor.organizationId,
        releaseId: input.releaseId,
        to: 'approved',
        operationKey: input.operationKey,
      });
    },
  };
}
