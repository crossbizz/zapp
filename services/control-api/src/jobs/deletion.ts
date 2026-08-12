import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { idSchema } from '@zapp/contracts';
import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import { organizations, projectDeletions, projects, type Database } from '@zapp/db';
import { and, asc, eq, gt, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { actorOf } from '../plugins/auth.js';
import type { AuditHook } from '../plugins/audit.js';
import { IdempotencyHeadersSchema } from '../plugins/idempotency.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { operationOf } from '../routes/runs.js';

const TARGETS = ['snapshots', 'git', 'objects', 'postgres'] as const;
const TargetSchema = z.enum(TARGETS);
export type ProjectDeletionTarget = z.infer<typeof TargetSchema>;

const ClaimedProjectDeletionSchema = z
  .object({
    projectId: idSchema('proj'),
    organizationId: idSchema('org'),
    leaseOwner: z.string().trim().min(1).max(128),
    snapshotsStatus: z.enum(['pending', 'verified']),
    gitStatus: z.enum(['pending', 'verified']),
    objectsStatus: z.enum(['pending', 'verified']),
    postgresStatus: z.enum(['pending', 'verified']),
  })
  .strict();

export type ClaimedProjectDeletion = z.infer<typeof ClaimedProjectDeletionSchema>;

const ProjectParamsSchema = z.object({ projectId: idSchema('proj') }).strict();
const OrganizationParamsSchema = z.object({ orgId: idSchema('org') }).strict();
export const ProjectDeletionStatusSchema = z
  .object({
    projectId: idSchema('proj'),
    status: z.enum(['queued', 'running', 'failed', 'completed']),
    targets: z
      .object({
        snapshots: z.enum(['pending', 'verified']),
        git: z.enum(['pending', 'verified']),
        objects: z.enum(['pending', 'verified']),
        postgres: z.enum(['pending', 'verified']),
      })
      .strict(),
    requestedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();
export type ProjectDeletionStatus = z.infer<typeof ProjectDeletionStatusSchema>;

export interface ProjectDeletionRequestStore {
  enqueue(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly requestedBy: string;
    readonly operationKey: string;
    readonly requestFingerprint: string;
    readonly now: Date;
    readonly audit: AuditHook<ProjectDeletionStatus>;
  }): Promise<
    | { readonly kind: 'accepted'; readonly deletion: ProjectDeletionStatus }
    | { readonly kind: 'replay'; readonly deletion: ProjectDeletionStatus }
    | { readonly kind: 'conflict' }
    | { readonly kind: 'not_found' }
  >;
  get(organizationId: string, projectId: string): Promise<ProjectDeletionStatus | undefined>;
  enqueueOrganization(input: {
    readonly organizationId: string;
    readonly requestedBy: string;
    readonly operationKey: string;
    readonly requestFingerprint: string;
    readonly now: Date;
    readonly audit: AuditHook<ProjectDeletionStatus>;
  }): Promise<readonly ProjectDeletionStatus[]>;
}

export interface DeletionStore {
  claim(workerId: string, now: Date, leaseMs: number): Promise<unknown>;
  markVerified(
    projectId: string,
    target: ProjectDeletionTarget,
    workerId: string,
    now: Date,
  ): Promise<boolean>;
  fail(projectId: string, errorCode: string, workerId: string, now: Date): Promise<boolean>;
}

export interface DeletionTargetPort {
  remove(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationKey: string;
  }): Promise<void>;
  absent(input: {
    readonly organizationId: string;
    readonly projectId: string;
  }): Promise<boolean>;
}

export interface ProjectDeletionJob {
  runOnce(now: Date): Promise<
    | { readonly kind: 'idle' }
    | {
        readonly kind: 'advanced' | 'completed' | 'failed';
        readonly target: ProjectDeletionTarget;
      }
  >;
}

interface DeletionTimers {
  setInterval(callback: () => void, delayMs: number): number | object;
  clearInterval(handle: number | object): void;
}

const DEFAULT_LEASE_MS = 60_000;
const RETRY_DELAY_MS = 5_000;

export function createProjectDeletionJob(options: {
  readonly store: DeletionStore;
  readonly workerId: string;
  readonly snapshots: DeletionTargetPort;
  readonly git: DeletionTargetPort;
  readonly objects: DeletionTargetPort;
  readonly postgres: DeletionTargetPort;
  readonly leaseMs?: number;
}): ProjectDeletionJob {
  const workerId = z.string().trim().min(1).max(128).parse(options.workerId);
  const leaseMs = z.number().int().min(1_000).max(15 * 60_000).parse(
    options.leaseMs ?? DEFAULT_LEASE_MS,
  );
  const ports: Record<ProjectDeletionTarget, DeletionTargetPort> = {
    snapshots: options.snapshots,
    git: options.git,
    objects: options.objects,
    postgres: options.postgres,
  };

  return {
    async runOnce(rawNow) {
      const now = validDate(rawNow);
      const rawClaim = await options.store.claim(workerId, now, leaseMs);
      if (rawClaim === undefined) return { kind: 'idle' };
      const claim = ClaimedProjectDeletionSchema.parse(rawClaim);
      const target = nextTarget(claim);
      if (target === undefined) return { kind: 'idle' };
      try {
        const port = ports[target];
        await port.remove({
          organizationId: claim.organizationId,
          projectId: claim.projectId,
          operationKey: deletionOperationKey(claim.projectId, target),
        });
        if (!(await port.absent(claim))) throw new DeletionTargetError('target_not_absent');
        if (!(await options.store.markVerified(claim.projectId, target, workerId, now))) {
          throw new DeletionTargetError('lease_lost');
        }
        return { kind: target === 'postgres' ? 'completed' : 'advanced', target };
      } catch (error) {
        const code =
          error instanceof DeletionTargetError ? error.code : 'target_delete_failed';
        try {
          await options.store.fail(claim.projectId, code, workerId, now);
        } catch {
          // The expired lease makes a failed durable write safe to redeliver.
        }
        return { kind: 'failed', target };
      }
    },
  };
}

export function createProjectDeletionLifecycle(options: {
  readonly job: ProjectDeletionJob;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  readonly onError?: (error: Error) => void;
  readonly timers?: DeletionTimers;
}) {
  const now = options.now ?? (() => new Date());
  const intervalMs = z.number().int().min(100).max(60_000).parse(options.intervalMs ?? 1_000);
  const timers =
    options.timers ??
    ({
      setInterval: (callback, delayMs) => setInterval(callback, delayMs),
      clearInterval: (handle) => {
        clearInterval(handle as ReturnType<typeof setInterval>);
      },
    } satisfies DeletionTimers);
  let handle: number | object | undefined;
  let active: Promise<void> | undefined;
  let closed = false;
  const poll = (): void => {
    if (closed || active !== undefined) return;
    active = options.job
      .runOnce(now())
      .then(() => undefined)
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        active = undefined;
      });
  };
  return {
    start(): Promise<void> {
      if (closed) throw new Error('project deletion lifecycle is closed');
      handle = timers.setInterval(poll, intervalMs);
      poll();
      return Promise.resolve();
    },
    async close(): Promise<void> {
      closed = true;
      if (handle !== undefined) timers.clearInterval(handle);
      handle = undefined;
      await active;
    },
  };
}

export function createDatabaseDeletionStore(database: Database): DeletionStore {
  return {
    async claim(rawWorkerId, rawNow, rawLeaseMs) {
      const workerId = z.string().trim().min(1).max(128).parse(rawWorkerId);
      const now = validDate(rawNow);
      const leaseMs = z.number().int().min(1_000).max(15 * 60_000).parse(rawLeaseMs);
      return await database.transaction(async (tx) => {
        const [candidate] = await tx
          .select()
          .from(projectDeletions)
          .where(
            and(
              ne(projectDeletions.status, 'completed'),
              lte(projectDeletions.nextAttemptAt, now),
              or(
                isNull(projectDeletions.leaseExpiresAt),
                lte(projectDeletions.leaseExpiresAt, now),
              ),
            ),
          )
          .orderBy(asc(projectDeletions.nextAttemptAt), asc(projectDeletions.projectId))
          .limit(1)
          .for('update', { skipLocked: true });
        if (candidate === undefined) return undefined;
        const [claimed] = await tx
          .update(projectDeletions)
          .set({
            status: 'running',
            leaseOwner: workerId,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
            updatedAt: now,
          })
          .where(eq(projectDeletions.projectId, candidate.projectId))
          .returning();
        return claimed === undefined ? undefined : claimView(claimed);
      });
    },
    async markVerified(rawProjectId, rawTarget, rawWorkerId, rawNow) {
      const projectId = idSchema('proj').parse(rawProjectId);
      const target = TargetSchema.parse(rawTarget);
      const workerId = z.string().trim().min(1).max(128).parse(rawWorkerId);
      const now = validDate(rawNow);
      return await database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(projectDeletions)
          .where(
            and(
              eq(projectDeletions.projectId, projectId),
              eq(projectDeletions.status, 'running'),
              eq(projectDeletions.leaseOwner, workerId),
              gt(projectDeletions.leaseExpiresAt, now),
            ),
          )
          .for('update');
        if (row === undefined) return false;
        const statuses = {
          snapshots: row.snapshotsStatus,
          git: row.gitStatus,
          objects: row.objectsStatus,
          postgres: row.postgresStatus,
          [target]: 'verified' as const,
        };
        const completed = TARGETS.every((candidate) => statuses[candidate] === 'verified');
        const updated = await tx
          .update(projectDeletions)
          .set({
            ...verifiedColumn(target),
            status: completed ? 'completed' : 'queued',
            leaseOwner: null,
            leaseExpiresAt: null,
            nextAttemptAt: now,
            lastErrorCode: null,
            updatedAt: now,
            completedAt: completed ? now : null,
          })
          .where(eq(projectDeletions.projectId, projectId))
          .returning({ projectId: projectDeletions.projectId });
        return updated.length === 1;
      });
    },
    async fail(rawProjectId, rawErrorCode, rawWorkerId, rawNow) {
      const projectId = idSchema('proj').parse(rawProjectId);
      const errorCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u).parse(rawErrorCode);
      const workerId = z.string().trim().min(1).max(128).parse(rawWorkerId);
      const now = validDate(rawNow);
      const updated = await database
        .update(projectDeletions)
        .set({
          status: 'failed',
          attempts: sql`${projectDeletions.attempts} + 1`,
          nextAttemptAt: new Date(now.getTime() + RETRY_DELAY_MS),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: errorCode,
          updatedAt: now,
        })
        .where(
          and(
            eq(projectDeletions.projectId, projectId),
            eq(projectDeletions.status, 'running'),
            eq(projectDeletions.leaseOwner, workerId),
          ),
        )
        .returning({ projectId: projectDeletions.projectId });
      return updated.length === 1;
    },
  };
}

export function createDatabaseProjectDeletionRequestStore(
  database: Database,
): ProjectDeletionRequestStore {
  return {
    async enqueue(rawInput) {
      const input = DeletionRequestSchema.parse(rawInput);
      return await database.transaction(async (tx) => {
        const [persisted] = await tx
          .select()
          .from(projectDeletions)
          .where(
            and(
              eq(projectDeletions.projectId, input.projectId),
              eq(projectDeletions.organizationId, input.organizationId),
            ),
          )
          .limit(1);
        if (persisted !== undefined) return existingDeletion(persisted, input);
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.id, input.projectId),
              eq(projects.organizationId, input.organizationId),
            ),
          )
          .for('update');
        if (project === undefined) return { kind: 'not_found' } as const;
        const [existing] = await tx
          .select()
          .from(projectDeletions)
          .where(
            and(
              eq(projectDeletions.projectId, input.projectId),
              eq(projectDeletions.organizationId, input.organizationId),
            ),
          )
          .limit(1);
        if (existing !== undefined) return existingDeletion(existing, input);
        const [created] = await tx
          .insert(projectDeletions)
          .values({
            projectId: input.projectId,
            organizationId: input.organizationId,
            requestedBy: input.requestedBy,
            operationKey: input.operationKey,
            requestFingerprint: input.requestFingerprint,
            status: 'queued',
            nextAttemptAt: input.now,
            requestedAt: input.now,
            updatedAt: input.now,
          })
          .returning();
        if (created === undefined) throw new Error('project deletion insert returned no row');
        const deletion = deletionView(created);
        await input.audit(tx, deletion);
        return { kind: 'accepted', deletion } as const;
      });
    },
    async get(rawOrganizationId, rawProjectId) {
      const organizationId = idSchema('org').parse(rawOrganizationId);
      const projectId = idSchema('proj').parse(rawProjectId);
      const [row] = await database
        .select()
        .from(projectDeletions)
        .where(
          and(
            eq(projectDeletions.projectId, projectId),
            eq(projectDeletions.organizationId, organizationId),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : deletionView(row);
    },
    async enqueueOrganization(rawInput) {
      const input = OrganizationDeletionRequestSchema.parse(rawInput);
      return await database.transaction(async (tx) => {
        const [organization] = await tx
          .select({ deletionRequestedAt: organizations.deletionRequestedAt })
          .from(organizations)
          .where(eq(organizations.id, input.organizationId))
          .for('update');
        if (organization === undefined) return [];
        if (organization.deletionRequestedAt === null) {
          await tx
            .update(organizations)
            .set({ deletionRequestedAt: input.now })
            .where(eq(organizations.id, input.organizationId));
        }
        const projectRows = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.organizationId, input.organizationId))
          .orderBy(asc(projects.id))
          .limit(1_001)
          .for('update');
        if (projectRows.length > 1_000) {
          throw new Error('organization project deletion batch exceeded its bound');
        }
        const deletions: ProjectDeletionStatus[] = [];
        for (const project of projectRows) {
          const childKey = childOperationKey(input.operationKey, project.id);
          const [existing] = await tx
            .select()
            .from(projectDeletions)
            .where(eq(projectDeletions.projectId, project.id))
            .limit(1);
          if (existing !== undefined) {
            deletions.push(deletionView(existing));
            continue;
          }
          const [created] = await tx
            .insert(projectDeletions)
            .values({
              projectId: project.id,
              organizationId: input.organizationId,
              requestedBy: input.requestedBy,
              operationKey: childKey,
              requestFingerprint: input.requestFingerprint,
              status: 'queued',
              nextAttemptAt: input.now,
              requestedAt: input.now,
              updatedAt: input.now,
            })
            .returning();
          if (created === undefined) throw new Error('organization deletion insert returned no row');
          const deletion = deletionView(created);
          await input.audit(tx, deletion);
          deletions.push(deletion);
        }
        return deletions;
      });
    },
  };
}

export function registerProjectDeletionRoutes(
  app: AppInstance,
  options: { readonly store: ProjectDeletionRequestStore; readonly now: () => Date },
): void {
  app.delete(
    '/v1/projects/:projectId',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ProjectParamsSchema,
        headers: IdempotencyHeadersSchema,
        response: { 202: z.object({ deletion: ProjectDeletionStatusSchema }).strict() },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      authorize(tenant, 'manage_organization');
      const idempotency = request.idempotency;
      if (idempotency === undefined) throw new Error('idempotency context missing');
      const result = await options.store.enqueue({
        organizationId: tenant.organizationId,
        projectId: request.params.projectId,
        requestedBy: actorOf(request),
        operationKey: operationOf(request),
        requestFingerprint: idempotency.fingerprint,
        now: options.now(),
        audit: async (tx, deletion) => {
          await request.audit(tx, {
            organizationId: tenant.organizationId,
            action: 'project.deletion_requested',
            target: { type: 'project', id: deletion.projectId },
            metadata: { operationKey: operationOf(request) },
          });
        },
      });
      if (result.kind === 'not_found') throw projectNotFound();
      if (result.kind === 'conflict') {
        throw new ApiError(
          'project_deletion_in_progress',
          409,
          'Project deletion is already in progress.',
        );
      }
      return await reply.status(202).send({ deletion: result.deletion });
    },
  );

  app.get(
    '/v1/projects/:projectId/deletion',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: ProjectParamsSchema,
        response: { 200: z.object({ deletion: ProjectDeletionStatusSchema }).strict() },
      },
    },
    async (request) => {
      const tenant = tenantOf(request);
      authorize(tenant, 'manage_organization');
      const deletion = await options.store.get(tenant.organizationId, request.params.projectId);
      if (deletion === undefined) throw projectNotFound();
      return { deletion };
    },
  );

  app.delete(
    '/v1/organizations/:orgId',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: OrganizationParamsSchema,
        headers: IdempotencyHeadersSchema,
        response: {
          202: z.object({ deletions: z.array(ProjectDeletionStatusSchema).max(1_000) }).strict(),
        },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      authorize(tenant, 'manage_organization');
      if (tenant.organizationId !== request.params.orgId) throw projectNotFound();
      const idempotency = request.idempotency;
      if (idempotency === undefined) throw new Error('idempotency context missing');
      const operationKey = operationOf(request);
      const deletions = await options.store.enqueueOrganization({
        organizationId: tenant.organizationId,
        requestedBy: actorOf(request),
        operationKey,
        requestFingerprint: idempotency.fingerprint,
        now: options.now(),
        audit: async (tx, deletion) => {
          await request.audit(tx, {
            organizationId: tenant.organizationId,
            action: 'project.deletion_requested',
            target: { type: 'project', id: deletion.projectId },
            metadata: { operationKey, organizationCascade: true },
          });
        },
      });
      return await reply.status(202).send({ deletions: [...deletions] });
    },
  );
}

export function createPostgresProjectDeletionTarget(database: Database): DeletionTargetPort {
  return {
    async remove(rawInput) {
      const input = deletionScope(rawInput);
      await database
        .delete(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.organizationId, input.organizationId),
          ),
        );
    },
    async absent(rawInput) {
      const input = deletionScope(rawInput);
      const [row] = await database
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.organizationId, input.organizationId),
          ),
        )
        .limit(1);
      return row === undefined;
    },
  };
}

export interface ProjectDeletionS3Sender {
  send(command: ListObjectsV2Command | DeleteObjectsCommand): Promise<unknown>;
}

const ObjectPageSchema = z
  .object({
    Contents: z.array(z.object({ Key: z.string().min(1).optional() }).passthrough()).optional(),
    IsTruncated: z.boolean().optional(),
    NextContinuationToken: z.string().min(1).optional(),
  })
  .passthrough();

export function createS3ProjectDeletionTarget(
  config: {
    readonly bucket: string;
    readonly endpoint?: string;
    readonly region?: string;
    readonly accessKeyId?: string;
    readonly secretAccessKey?: string;
  },
  sender: ProjectDeletionS3Sender = new S3Client({
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.region === undefined ? {} : { region: config.region }),
    ...(config.accessKeyId === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey ?? '',
          },
        }),
    forcePathStyle: true,
  }),
): DeletionTargetPort {
  const bucket = z.string().trim().min(1).parse(config.bucket);
  return {
    async remove(rawInput) {
      const input = deletionScope(rawInput);
      const prefix = objectPrefix(input);
      let continuationToken: string | undefined;
      do {
        const page = ObjectPageSchema.parse(
          await sender.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: prefix,
              MaxKeys: 1_000,
              ...(continuationToken === undefined
                ? {}
                : { ContinuationToken: continuationToken }),
            }),
          ),
        );
        const keys = (page.Contents ?? []).flatMap(({ Key }) =>
          Key === undefined ? [] : [z.string().startsWith(prefix).parse(Key)],
        );
        if (keys.length > 0) {
          await sender.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
            }),
          );
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && continuationToken === undefined) {
          throw new Error('object listing omitted its continuation token');
        }
      } while (continuationToken !== undefined);
    },
    async absent(rawInput) {
      const input = deletionScope(rawInput);
      const page = ObjectPageSchema.parse(
        await sender.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: objectPrefix(input),
            MaxKeys: 1,
          }),
        ),
      );
      return (page.Contents ?? []).every(({ Key }) => Key === undefined);
    },
  };
}

export function createGitProjectDeletionTarget(options: {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}): DeletionTargetPort {
  const baseUrl = httpBaseUrl(options.baseUrl);
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const token = async (): Promise<string> =>
    (await signer.signServiceToken({ service: 'control-api', aud: 'git-service' })).token;
  return {
    async remove(rawInput) {
      const input = deletionScope(rawInput);
      const response = await safeFetch(
        doFetch,
        `${baseUrl}/internal/git/repositories/${input.organizationId}/${input.projectId}`,
        {
          method: 'DELETE',
          headers: {
            accept: 'application/json',
            'idempotency-key': operationKeyOf(rawInput),
            'x-zapp-service-token': await token(),
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.status !== 204) throw new Error('git deletion was refused');
    },
    async absent(rawInput) {
      const input = deletionScope(rawInput);
      const response = await safeFetch(
        doFetch,
        `${baseUrl}/internal/git/repositories/${input.organizationId}/${input.projectId}/exists`,
        {
          method: 'GET',
          headers: { accept: 'application/json', 'x-zapp-service-token': await token() },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.status !== 200) throw new Error('git absence probe was refused');
      return !z.object({ exists: z.boolean() }).strict().parse(await response.json()).exists;
    },
  };
}

export function createSandboxSnapshotDeletionTarget(options: {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}): DeletionTargetPort {
  const baseUrl = httpBaseUrl(options.baseUrl);
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const token = async (): Promise<string> =>
    (await signer.signServiceToken({ service: 'control-api', aud: 'sandbox-service' })).token;
  const request = async (
    input: z.infer<typeof DeletionScopeSchema>,
    path: 'delete' | 'absent',
    init: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    headers.set('x-zapp-organization-id', input.organizationId);
    headers.set('x-zapp-project-id', input.projectId);
    headers.set('x-zapp-service-token', await token());
    return await safeFetch(
      doFetch,
      `${baseUrl}/internal/projects/${input.projectId}/snapshots/${path}`,
      {
        ...init,
        headers,
        signal: AbortSignal.timeout(10_000),
      },
    );
  };
  return {
    async remove(rawInput) {
      const input = deletionScope(rawInput);
      const response = await request(input, 'delete', {
        method: 'POST',
        headers: { 'idempotency-key': operationKeyOf(rawInput) },
      });
      if (response.status !== 200) throw new Error('snapshot deletion was refused');
      if (!z.object({ absent: z.literal(true) }).strict().safeParse(await response.json()).success) {
        throw new Error('snapshot deletion did not verify absence');
      }
    },
    async absent(rawInput) {
      const input = deletionScope(rawInput);
      const response = await request(input, 'absent', { method: 'GET' });
      if (response.status !== 200) throw new Error('snapshot absence probe was refused');
      return z.object({ absent: z.boolean() }).strict().parse(await response.json()).absent;
    },
  };
}

function nextTarget(claim: ClaimedProjectDeletion): ProjectDeletionTarget | undefined {
  return TARGETS.find((target) => claim[`${target}Status`] === 'pending');
}

function claimView(row: typeof projectDeletions.$inferSelect): ClaimedProjectDeletion {
  return ClaimedProjectDeletionSchema.parse({
    projectId: row.projectId,
    organizationId: row.organizationId,
    leaseOwner: row.leaseOwner,
    snapshotsStatus: row.snapshotsStatus,
    gitStatus: row.gitStatus,
    objectsStatus: row.objectsStatus,
    postgresStatus: row.postgresStatus,
  });
}

function verifiedColumn(target: ProjectDeletionTarget): Partial<typeof projectDeletions.$inferInsert> {
  switch (target) {
    case 'snapshots':
      return { snapshotsStatus: 'verified' };
    case 'git':
      return { gitStatus: 'verified' };
    case 'objects':
      return { objectsStatus: 'verified' };
    case 'postgres':
      return { postgresStatus: 'verified' };
  }
}

const DeletionScopeSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
  })
  .passthrough();

function deletionScope(input: unknown): z.infer<typeof DeletionScopeSchema> {
  return DeletionScopeSchema.parse(input);
}

function objectPrefix(input: z.infer<typeof DeletionScopeSchema>): string {
  return `org/${input.organizationId}/project/${input.projectId}/`;
}

function deletionOperationKey(projectId: string, target: ProjectDeletionTarget): string {
  return `op_${createHash('sha256').update(`project-deletion:${projectId}:${target}`).digest('hex')}`;
}

function operationKeyOf(input: unknown): string {
  return z
    .object({ operationKey: z.string().regex(/^op_[a-f0-9]{64}$/u) })
    .passthrough()
    .parse(input).operationKey;
}

function httpBaseUrl(raw: string): string {
  return z
    .string()
    .url()
    .refine((value) => /^https?:\/\//u.test(value))
    .transform((value) => value.replace(/\/+$/u, ''))
    .parse(raw);
}

async function safeFetch(
  doFetch: (input: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await doFetch(url, init);
  } catch (error) {
    throw new Error('project deletion dependency was unreachable', { cause: error });
  }
}

const DeletionRequestSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    requestedBy: idSchema('user'),
    operationKey: z.string().min(1).max(256),
    requestFingerprint: z.string().min(1).max(256),
    now: z.date(),
    audit: z.function(),
  })
  .strict();
const OrganizationDeletionRequestSchema = DeletionRequestSchema.omit({ projectId: true });

function deletionView(row: typeof projectDeletions.$inferSelect): ProjectDeletionStatus {
  return ProjectDeletionStatusSchema.parse({
    projectId: row.projectId,
    status: row.status,
    targets: {
      snapshots: row.snapshotsStatus,
      git: row.gitStatus,
      objects: row.objectsStatus,
      postgres: row.postgresStatus,
    },
    requestedAt: row.requestedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

function existingDeletion(
  row: typeof projectDeletions.$inferSelect,
  input: z.infer<typeof DeletionRequestSchema>,
):
  | { readonly kind: 'replay'; readonly deletion: ProjectDeletionStatus }
  | { readonly kind: 'conflict' } {
  if (
    row.requestedBy !== input.requestedBy ||
    row.operationKey !== input.operationKey ||
    row.requestFingerprint !== input.requestFingerprint
  ) {
    return { kind: 'conflict' };
  }
  return { kind: 'replay', deletion: deletionView(row) };
}

function projectNotFound(): ApiError {
  return new ApiError('project_not_found', 404, 'The project was not found.');
}

function childOperationKey(operationKey: string, projectId: string): string {
  return `op_${createHash('sha256').update(`${operationKey}:${projectId}`).digest('hex')}`;
}

export function createUnavailableProjectDeletionRequestStore(): ProjectDeletionRequestStore {
  const unavailable = (): never => {
    throw new ApiError('deletion_unavailable', 503, 'Project deletion is temporarily unavailable.');
  };
  return {
    enqueue: unavailable,
    enqueueOrganization: unavailable,
    get: unavailable,
  };
}

class DeletionTargetError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('invalid deletion clock');
  }
  return value;
}
import { createHash } from 'node:crypto';
