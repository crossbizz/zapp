import {
  CreateWorkspaceInputSchema,
  CheckpointKindSchema,
  ExecutionContractSchema,
  ExecInputSchema,
  EnvVarsSchema,
  NetworkProfileSchema,
  PreviewLifecycleEventSchema,
  ResourceProfileSchema,
  WorkspacePurposeSchema,
  WorkspaceHandleSchema,
  WorkspaceStatusSchema,
  idSchema,
  type CreateWorkspaceInput,
  type ExecutionContract,
  type ExecInput,
  type PreviewLifecycleEvent,
  type WorkspaceHandle,
  type WorkspacePurpose,
  type WorkspaceStatus,
} from '@zapp/contracts';
import { withObservabilitySpan } from '@zapp/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { SandboxServiceApp } from '../app.js';
import type { RunawayComputeGovernor } from '../lifecycle/governor.js';
import {
  NetworkPolicyRecordSchema,
  resolveNetworkPolicy,
  type NetworkPolicyRecorder,
} from '../network/profiles.js';
import type { WorkspaceGitService } from '../provider/git-bootstrap.js';
import {
  ModalWorkspaceNotFoundError,
  ModalWorkspaceReadinessError,
  ModalWorkspaceTagMismatchError,
  type ModalWorkspaceAttachment,
} from '../provider/modal.js';
import { BranchLockedResponseSchema } from '../provider/volumes.js';
import type { ActiveCostRecording } from '../cost/recorder.js';
import type { CheckpointRecord } from '../checkpoint/service.js';
import {
  assertSandboxEnvironment,
  createSecretStreamRedactor,
  redactExecResult,
  type ScopedSecretInjector,
  type SecretRegistry,
} from '../secrets/injector.js';

const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);

export const WorkspaceLifecycleRowSchema = z
  .object({
    id: idSchema('ws'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    branchId: idSchema('br').nullable(),
    provider: z.literal('modal'),
    providerWorkspaceId: z.string().min(1).nullable(),
    status: WorkspaceStatusSchema,
    resourceProfile: ResourceProfileSchema,
    snapshotRef: z.string().nullable(),
    createdAt: z.coerce.date(),
    lastActiveAt: z.coerce.date().nullable(),
    terminatedAt: z.coerce.date().nullable(),
  })
  .strict();
export type WorkspaceLifecycleRow = z.infer<typeof WorkspaceLifecycleRowSchema>;

const RequestedWorkspaceRowSchema = WorkspaceLifecycleRowSchema.extend({
  branchId: idSchema('br'),
  providerWorkspaceId: z.null(),
  status: z.literal('requested'),
  snapshotRef: z.null(),
  lastActiveAt: z.null(),
  terminatedAt: z.null(),
}).strict();

export const WorkspaceRowIdempotencyKeySchema = z
  .object({
    runId: idSchema('run'),
    taskId: idSchema('task'),
    purpose: WorkspacePurposeSchema,
    branchId: idSchema('br'),
    branchName: z.string().trim().min(1).max(255),
  })
  .strict();
export type WorkspaceRowIdempotencyKey = z.infer<typeof WorkspaceRowIdempotencyKeySchema>;

export interface WorkspaceRowClaim {
  readonly created: boolean;
  /** On a replay, the boundary waits until the original create reaches ready or terminated. */
  readonly row: WorkspaceLifecycleRow;
}

export interface WorkspaceAttachmentRecord {
  readonly row: WorkspaceLifecycleRow;
  readonly attachment: ModalWorkspaceAttachment;
}

/** Durable row operations are injected so CP-9's tenant repository remains the row owner. */
export interface WorkspaceRowBoundary {
  projectOwnedBy(projectId: string, organizationId: string): Promise<boolean>;
  claimCreate(
    row: WorkspaceLifecycleRow,
    key: WorkspaceRowIdempotencyKey,
    attachment: ModalWorkspaceAttachment,
  ): Promise<WorkspaceRowClaim>;
  bindProviderWorkspaceId(
    workspaceId: string,
    providerWorkspaceId: string,
    expectedStatus: 'provisioning',
  ): Promise<WorkspaceLifecycleRow>;
  get(
    workspaceId: string,
    organizationId: string,
    projectId: string,
  ): Promise<WorkspaceLifecycleRow | undefined>;
  getAttachment(
    workspaceId: string,
    organizationId: string,
    projectId: string,
  ): Promise<WorkspaceAttachmentRecord | undefined>;
  /** Durable active attachments used to restore lifecycle observation after restart. */
  listAttachments(): Promise<readonly WorkspaceAttachmentRecord[]>;
  transition(
    workspaceId: string,
    status: WorkspaceStatus,
    patch?: { readonly providerWorkspaceId?: string; readonly terminatedAt?: Date },
    expectedStatus?: WorkspaceStatus,
  ): Promise<WorkspaceLifecycleRow>;
}

/** Durable single-owner observation for a ready workspace's preview supervisor. */
export interface PreviewMonitorCoordinator {
  /** Enables observation and claims it when no unexpired replica owns it. */
  activateAndClaim(
    workspaceId: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<string | undefined>;
  /** Claims an already-enabled monitor during process recovery. */
  claim(workspaceId: string, ownerId: string, leaseMs: number): Promise<string | undefined>;
  /** Renewal fails after durable termination/revocation or ownership loss. */
  renew(workspaceId: string, leaseToken: string, leaseMs: number): Promise<boolean>;
  /** Disables a terminal monitor only while the same fenced lease still owns it. */
  complete(workspaceId: string, leaseToken: string): Promise<boolean>;
  /** Disables observation for every replica. */
  revoke(workspaceId: string): Promise<void>;
  /** Relinquishes this replica's lease without disabling future recovery. */
  release(workspaceId: string, leaseToken: string): Promise<void>;
}

export interface WorkspaceLifecycleProvider {
  readonly lockedImageTag: string;
  readonly attachmentEnvironment: ModalWorkspaceAttachment['requiredTags']['environment'];
  imageTagForPurpose(purpose: WorkspacePurpose): string;
  createWorkspace(
    input: CreateWorkspaceInput,
    onAllocated?: (providerWorkspaceId: string) => Promise<void>,
  ): Promise<WorkspaceHandle>;
  attachWorkspace(
    providerWorkspaceId: string,
    attachment: ModalWorkspaceAttachment,
  ): Promise<WorkspaceHandle>;
  terminateWorkspace(providerWorkspaceId: string): Promise<void>;
  getStatus(providerWorkspaceId: string): Promise<WorkspaceStatus>;
}

export interface WorkspaceAgentProvider extends WorkspaceLifecycleProvider {
  measureProjectVolumeBytes?(input: {
    readonly organizationId: string;
    readonly projectId: string;
  }): Promise<string>;
  snapshotWorkspace?(
    providerWorkspaceId: string,
    ttlMs: number,
  ): Promise<{ providerSnapshotId: string; logicalBytes: string; expiresAt: string }>;
  resolvePreviewTunnel?(providerWorkspaceId: string): Promise<URL>;
  exec(input: ExecInput, idempotencyKey?: string): Promise<z.infer<typeof ExecResultSchema>>;
  execStream(
    input: ExecInput,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): AsyncIterable<z.infer<typeof ExecStreamRecordSchema>>;
  killExec(
    providerWorkspaceId: string,
    pid: number,
    executionId: string,
    idempotencyKey?: string,
  ): Promise<z.infer<typeof KillResponseSchema>>;
  readFile(providerWorkspaceId: string, path: string): Promise<Uint8Array>;
  writeFile(
    providerWorkspaceId: string,
    path: string,
    data: Uint8Array,
    idempotencyKey?: string,
  ): Promise<void>;
  listFiles(
    providerWorkspaceId: string,
    path: string,
    options?: { glob?: string; maxDepth?: number },
  ): Promise<z.infer<typeof FileListResponseSchema>>;
  git(
    providerWorkspaceId: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<z.infer<typeof GitResponseSchema>>;
  health(providerWorkspaceId: string): Promise<z.infer<typeof HealthResponseSchema>>;
  metrics(providerWorkspaceId: string): Promise<z.infer<typeof MetricsResponseSchema>>;
  readFileForUpdate(providerWorkspaceId: string, path: string): Promise<unknown>;
  writeFilesAtomically(
    providerWorkspaceId: string,
    files: readonly { path: string; data: Uint8Array; expectedRevision?: string }[],
    idempotencyKey?: string,
  ): Promise<void>;
  search(providerWorkspaceId: string, input: unknown): Promise<z.infer<typeof ExecResultSchema>>;
  deleteFile(
    providerWorkspaceId: string,
    path: string,
    idempotencyKey?: string,
  ): Promise<{ alreadyAbsent: boolean }>;
  renameFile(providerWorkspaceId: string, input: unknown, idempotencyKey?: string): Promise<void>;
  startDevServer(
    providerWorkspaceId: string,
    contract: ExecutionContract,
    idempotencyKey?: string,
  ): Promise<z.infer<typeof DevServerResponseSchema>>;
  restartDevServer(
    providerWorkspaceId: string,
    contract: ExecutionContract,
    idempotencyKey?: string,
  ): Promise<z.infer<typeof DevServerResponseSchema>>;
  readDevServerLogs(
    providerWorkspaceId: string,
    query: z.infer<typeof DevServerLogsQuerySchema>,
  ): Promise<z.infer<typeof DevServerLogsResponseSchema>>;
}

export { PreviewLifecycleEventSchema };

export interface PreviewLifecycleEventPort {
  /** CP-13 consumes eventKey as the durable idempotency identity. */
  emit(event: PreviewLifecycleEvent): Promise<void>;
}

const CreateWorkspaceBodySchema = z
  .object({
    workspace: RequestedWorkspaceRowSchema,
    branchName: z.string().trim().min(1).max(255),
    runId: idSchema('run'),
    taskId: idSchema('task'),
    purpose: WorkspacePurposeSchema,
    env: EnvVarsSchema,
    networkProfile: NetworkProfileSchema,
    integrationDomains: z.array(z.string().min(1)).max(100).default([]),
    operationKey: OperationKeySchema,
  })
  .strict();
const WorkspaceScopeHeadersSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
  })
  .strict();
const WorkspaceParamsSchema = z.object({ workspaceId: idSchema('ws') }).strict();
const ProjectParamsSchema = z.object({ projectId: idSchema('proj') }).strict();
const StorageMeasurementSchema = z
  .object({
    snapshotBytes: z.string().regex(/^\d+$/u),
    volumeBytes: z.string().regex(/^\d+$/u),
  })
  .strict();
const TerminateBodySchema = z.object({ operationKey: OperationKeySchema }).strict();
const CheckpointBodySchema = z
  .object({ kind: CheckpointKindSchema, operationKey: OperationKeySchema })
  .strict();
const CheckpointResponseSchema = z
  .object({ snapshotRef: z.string().regex(/^ckpt_[a-f0-9]{64}$/u) })
  .strict();
const AttachBodySchema = TerminateBodySchema;
const OrganizationParamsSchema = z.object({ organizationId: idSchema('org') }).strict();
const TerminateAllBodySchema = z
  .object({
    actorUserId: idSchema('user'),
    reason: z.string().trim().min(10).max(500),
    operationKey: OperationKeySchema,
  })
  .strict();
const TerminateAllResponseSchema = z
  .object({ terminated: z.number().int().nonnegative() })
  .strict();
const WorkspaceResponseSchema = z.object({ workspace: WorkspaceLifecycleRowSchema }).strict();
const PublicWorkspaceLifecycleRowSchema = WorkspaceLifecycleRowSchema.omit({
  providerWorkspaceId: true,
}).strip();
const AttachedWorkspaceResponseSchema = z
  .object({ workspace: PublicWorkspaceLifecycleRowSchema })
  .strict();
const StatusResponseSchema = z
  .object({ workspace: WorkspaceLifecycleRowSchema, providerStatus: WorkspaceStatusSchema })
  .strict();
const SecretExecScopeSchema = z
  .object({
    environmentId: idSchema('env'),
    secretIds: z.array(idSchema('sec')).min(1).max(200),
  })
  .strict();
const ExecCommandBodySchema = ExecInputSchema.omit({
  providerWorkspaceId: true,
  env: true,
}).strip();
const ExecBodySchema = ExecCommandBodySchema.extend({
  secretScope: SecretExecScopeSchema.optional(),
}).strict();
const ExecQuerySchema = z.object({ stream: z.literal('1').optional() }).strict();
const ExecParamsSchema = WorkspaceParamsSchema.extend({
  pid: z.coerce.number().int().positive(),
}).strict();
const KillBodySchema = z.object({ executionId: z.string().uuid() }).strict();
const FileQuerySchema = z.object({ path: z.string().min(1) }).strict();
const ListQuerySchema = z
  .object({
    path: z.string().min(1).default('.'),
    glob: z.string().min(1).optional(),
    maxDepth: z.coerce.number().int().min(0).max(100).optional(),
  })
  .strict();
const GitBodySchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.enum(['status', 'diff', 'log', 'show', 'push', 'checkout', 'branch', 'restore']),
      args: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('add_commit'),
      paths: z.array(z.string()).min(1),
      message: z.string().min(1),
    })
    .strict(),
]);
const AtomicWriteBodySchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string().min(1),
            dataBase64: z
              .string()
              .refine(
                (value) => Buffer.from(value, 'base64').toString('base64') === value,
                'Expected canonical base64',
              ),
            expectedRevision: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const SearchBodySchema = z
  .object({
    pattern: z.string(),
    path: z.string().min(1),
    glob: z.string().min(1).optional(),
    fixedStrings: z.boolean().optional(),
    ignoreCase: z.boolean().optional(),
  })
  .strict();
const RenameBodySchema = z
  .object({
    source: z.string().min(1),
    destination: z.string().min(1),
    overwrite: z.literal('replace'),
  })
  .strict();
const DevServerBodySchema = z.object({ contract: ExecutionContractSchema }).strict();
const ExecResultSchema = z
  .object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
const ExecStreamRecordSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('started'),
      pid: z.number().int().positive(),
      executionId: z.string().uuid(),
      at: z.string().datetime(),
    })
    .strict(),
  z
    .object({ type: z.enum(['stdout', 'stderr']), data: z.string(), at: z.string().datetime() })
    .strict(),
  z
    .object({
      type: z.literal('exit'),
      exitCode: z.number().int(),
      durationMs: z.number().nonnegative(),
      truncated: z.boolean(),
      at: z.string().datetime(),
    })
    .strict(),
]);
const KillResponseSchema = z.object({ killed: z.boolean() }).strict();
const FileListResponseSchema = z.array(
  z.object({ path: z.string(), type: z.enum(['file', 'directory', 'symlink']) }).strict(),
);
const GitResponseSchema = z
  .object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() })
  .strict();
const HealthResponseSchema = z
  .object({
    ok: z.boolean(),
    details: z.string(),
    devServer: z
      .object({
        port: z.number().int().min(1).max(65_535),
        pid: z.number().int().positive(),
        supervisorId: z.string().min(1),
        owned: z.boolean(),
        httpReady: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const MetricsResponseSchema = z
  .object({
    at: z.string().datetime(),
    activeChildren: z.number().int().nonnegative(),
    cpu: z
      .object({ userMicros: z.number().nonnegative(), systemMicros: z.number().nonnegative() })
      .strict(),
    memory: z
      .object({
        rssBytes: z.number().nonnegative(),
        heapTotalBytes: z.number().nonnegative(),
        heapUsedBytes: z.number().nonnegative(),
        externalBytes: z.number().nonnegative(),
        arrayBuffersBytes: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();
const OkResponseSchema = z.object({ ok: z.literal(true) }).strict();
const DeleteResponseSchema = z.object({ ok: z.literal(true), alreadyAbsent: z.boolean() }).strict();
const DevServerResponseSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    pid: z.number().int().positive(),
    supervisorId: z.string().min(1),
    ownership: z.enum(['process', 'process_group']),
  })
  .strict();
const DevServerLogsQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().positive().max(1_000).default(100),
  })
  .strict();
const DevServerLogsResponseSchema = z
  .object({
    entries: z.array(
      z
        .object({
          cursor: z.number().int().positive(),
          at: z.string().datetime(),
          stream: z.enum(['stdout', 'stderr']),
          message: z.string(),
        })
        .strict(),
    ),
    nextCursor: z.number().int().nonnegative(),
    truncated: z.boolean(),
    state: z.enum(['idle', 'starting', 'ready', 'restarting', 'failed']),
    failureId: z.string().min(1).nullable(),
  })
  .strict();

function requireIdempotencyKey(header: string | string[] | undefined, operationKey: string): void {
  if (typeof header !== 'string' || !OperationKeySchema.safeParse(header).success) {
    throw Object.assign(new Error('A valid idempotency key is required.'), { statusCode: 400 });
  }
  if (header !== operationKey) {
    throw Object.assign(new Error('Idempotency key does not match the request.'), {
      statusCode: 400,
    });
  }
}

function readIdempotencyKey(header: string | string[] | undefined): string {
  const parsed = OperationKeySchema.safeParse(typeof header === 'string' ? header : undefined);
  if (!parsed.success) {
    throw Object.assign(new Error('A valid idempotency key is required.'), { statusCode: 400 });
  }
  return parsed.data;
}

function readWorkspaceScope(request: FastifyRequest) {
  return WorkspaceScopeHeadersSchema.parse({
    organizationId: request.headers['x-zapp-organization-id'],
    projectId: request.headers['x-zapp-project-id'],
  });
}

function createInputFor(
  row: WorkspaceLifecycleRow,
  body: z.infer<typeof CreateWorkspaceBodySchema>,
  lockedImageTag: string,
): CreateWorkspaceInput {
  return CreateWorkspaceInputSchema.parse({
    organizationId: row.organizationId,
    projectId: row.projectId,
    branchId: RequestedWorkspaceRowSchema.parse(row).branchId,
    runId: body.runId,
    taskId: body.taskId,
    purpose: body.purpose,
    resourceProfile: row.resourceProfile,
    imageTag: lockedImageTag,
    env: body.env,
    networkProfile: body.networkProfile,
  });
}

export function registerWorkspaceRoutes(
  app: SandboxServiceApp,
  deps: {
    readonly provider: WorkspaceAgentProvider;
    readonly rows: WorkspaceRowBoundary;
    readonly workspaceGit: WorkspaceGitService;
    readonly secrets: ScopedSecretInjector;
    readonly networkPolicies: NetworkPolicyRecorder;
    readonly events: PreviewLifecycleEventPort;
    readonly previewMonitors: PreviewMonitorCoordinator;
    readonly governor: RunawayComputeGovernor;
    readonly previewMonitorOwnerId: string;
    readonly previewMonitorLeaseMs?: number;
    readonly previewMonitorStandbyPollIntervalMs?: number;
    readonly previewFailurePollIntervalMs?: number;
    readonly now: () => Date;
    readonly storageMeasurements?: {
      measureProjectBytes(input: {
        readonly organizationId: string;
        readonly projectId: string;
      }): Promise<unknown>;
    };
    readonly checkpointService?: {
      checkpoint(input: unknown): Promise<CheckpointRecord>;
    };
    readonly costRecorder?: {
      start(input: {
        readonly workspaceId: string;
        readonly providerWorkspaceId: string;
        readonly organizationId: string;
        readonly projectId: string;
        readonly runId: string;
        readonly taskId: string;
        readonly operationKey?: string;
        readonly profile: string;
      }): Promise<ActiveCostRecording>;
    };
  },
): void {
  const failureMonitors = new Map<
    string,
    { readonly controller: AbortController; readonly leaseToken: string }
  >();
  const failureMonitorClaims = new Set<string>();
  const activeCostRecordings = new Map<string, ActiveCostRecording>();
  const costRecordingStarts = new Map<string, Promise<ActiveCostRecording | undefined>>();
  const lifecycle = { closing: false };
  const ensureCostRecording = async (
    record: WorkspaceAttachmentRecord,
    operationKey?: string,
  ): Promise<ActiveCostRecording | undefined> => {
    if (deps.costRecorder === undefined || record.row.providerWorkspaceId === null) {
      return undefined;
    }
    const current = activeCostRecordings.get(record.row.id);
    if (current !== undefined) return current;
    const pending = costRecordingStarts.get(record.row.id);
    if (pending !== undefined) return await pending;
    const providerWorkspaceId = record.row.providerWorkspaceId;
    const costRecorder = deps.costRecorder;
    const start = (async () => {
      const recording = await costRecorder.start({
        workspaceId: record.row.id,
        providerWorkspaceId,
        organizationId: record.row.organizationId,
        projectId: record.row.projectId,
        runId: record.attachment.requiredTags.run_id,
        taskId: record.attachment.requiredTags.task_id,
        ...(operationKey === undefined ? {} : { operationKey }),
        profile: record.row.resourceProfile,
      });
      if (lifecycle.closing) {
        await recording.close();
        return undefined;
      }
      activeCostRecordings.set(record.row.id, recording);
      return recording;
    })();
    costRecordingStarts.set(record.row.id, start);
    try {
      return await start;
    } finally {
      if (costRecordingStarts.get(record.row.id) === start) {
        costRecordingStarts.delete(record.row.id);
      }
    }
  };
  const acquisitionController = new AbortController();
  let acquisitionLoop: Promise<void> | undefined;
  const costRecoveryController = new AbortController();
  let costRecoveryLoop: Promise<void> | undefined;
  app.addHook('onReady', () => {
    deps.governor.start();
  });
  app.addHook('onClose', async () => {
    await deps.governor.stop();
  });
  const isClosing = (): boolean => lifecycle.closing;
  const previewMonitorLeaseMs = deps.previewMonitorLeaseMs ?? 5_000;
  const previewMonitorStandbyPollIntervalMs =
    deps.previewMonitorStandbyPollIntervalMs ?? Math.max(250, previewMonitorLeaseMs / 2);
  const waitFor = (milliseconds: number, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timeout);
        resolve(true);
      };
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(false);
      }, milliseconds);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  const waitForPoll = (signal: AbortSignal): Promise<boolean> =>
    waitFor(deps.previewFailurePollIntervalMs ?? 1_000, signal);
  const settleOrAbort = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) throw new Error('cost recording recovery aborted');
    return await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        reject(new Error('cost recording recovery aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error instanceof Error ? error : new Error('cost recording recovery failed'));
        },
      );
    });
  };
  const resolveWorkspace = async (
    workspaceId: string,
    request: FastifyRequest,
  ): Promise<WorkspaceLifecycleRow> => {
    const scope = readWorkspaceScope(request);
    const row = await deps.rows.get(workspaceId, scope.organizationId, scope.projectId);
    if (row === undefined || row.providerWorkspaceId === null || row.status === 'terminated') {
      throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
    }
    return row;
  };
  const resolveProviderWorkspaceId = async (
    workspaceId: string,
    request: FastifyRequest,
  ): Promise<string> => {
    const row = await resolveWorkspace(workspaceId, request);
    return z.string().min(1).parse(row.providerWorkspaceId);
  };
  const resolveAttachment = async (
    workspaceId: string,
    request: FastifyRequest,
  ): Promise<WorkspaceAttachmentRecord> => {
    const scope = readWorkspaceScope(request);
    const record = await deps.rows.getAttachment(
      workspaceId,
      scope.organizationId,
      scope.projectId,
    );
    if (
      record === undefined ||
      record.row.providerWorkspaceId === null ||
      record.row.status === 'terminated'
    ) {
      throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
    }
    return record;
  };
  const emitPreview = (
    record: WorkspaceAttachmentRecord,
    operationKey: string,
    action: 'start' | 'restart',
    type: 'preview.starting' | 'preview.ready' | 'preview.failed',
    payload: Record<string, unknown> = {},
  ): Promise<void> =>
    deps.events.emit(
      PreviewLifecycleEventSchema.parse({
        eventKey: `ws13:${operationKey}:${action}:${type}`,
        organizationId: record.row.organizationId,
        projectId: record.row.projectId,
        runId: record.attachment.requiredTags.run_id,
        taskId: record.attachment.requiredTags.task_id,
        occurredAt: deps.now().toISOString(),
        type,
        visibility: 'user',
        payload: { workspaceId: record.row.id, action, ...payload },
      }),
    );
  const emitTerminalPreviewFailure = async (
    record: WorkspaceAttachmentRecord,
    failureId: string,
    monitorLeaseToken: string,
  ): Promise<void> => {
    await deps.events.emit(
      PreviewLifecycleEventSchema.parse({
        eventKey: `ws13:failure:${record.row.id}:${failureId}`,
        organizationId: record.row.organizationId,
        projectId: record.row.projectId,
        runId: record.attachment.requiredTags.run_id,
        taskId: record.attachment.requiredTags.task_id,
        occurredAt: deps.now().toISOString(),
        type: 'preview.failed',
        visibility: 'user',
        payload: {
          workspaceId: record.row.id,
          code: 'restart_limit_exceeded',
          monitorLeaseToken,
        },
      }),
    );
  };
  const monitorTerminalPreviewFailure = async (
    record: WorkspaceAttachmentRecord,
    providerWorkspaceId: string,
    activate: boolean,
  ): Promise<void> => {
    const existing = failureMonitors.get(record.row.id);
    if (activate && existing !== undefined) {
      failureMonitors.delete(record.row.id);
      existing.controller.abort();
      await deps.previewMonitors.release(record.row.id, existing.leaseToken);
    } else if (existing !== undefined) {
      return;
    }
    if (isClosing() || failureMonitorClaims.has(record.row.id)) return;
    failureMonitorClaims.add(record.row.id);
    let monitor: { readonly controller: AbortController; readonly leaseToken: string } | undefined;
    try {
      const leaseToken = await (activate
        ? deps.previewMonitors.activateAndClaim(
            record.row.id,
            deps.previewMonitorOwnerId,
            previewMonitorLeaseMs,
          )
        : deps.previewMonitors.claim(
            record.row.id,
            deps.previewMonitorOwnerId,
            previewMonitorLeaseMs,
          ));
      if (leaseToken === undefined) return;
      if (isClosing()) {
        await deps.previewMonitors.release(record.row.id, leaseToken);
        return;
      }
      monitor = { controller: new AbortController(), leaseToken };
      failureMonitors.set(record.row.id, monitor);
    } finally {
      failureMonitorClaims.delete(record.row.id);
    }
    const { controller, leaseToken } = monitor;
    void (async () => {
      let cursor = 0;
      while (!controller.signal.aborted) {
        if (await waitForPoll(controller.signal)) return;
        try {
          if (
            !(await deps.previewMonitors.renew(record.row.id, leaseToken, previewMonitorLeaseMs))
          ) {
            return;
          }
          const page = DevServerLogsResponseSchema.parse(
            await deps.provider.readDevServerLogs(providerWorkspaceId, {
              after: cursor,
              limit: 100,
            }),
          );
          cursor = page.nextCursor;
          if (
            !(await deps.previewMonitors.renew(record.row.id, leaseToken, previewMonitorLeaseMs))
          ) {
            return;
          }
          if (page.state === 'failed' && page.failureId !== null) {
            await emitTerminalPreviewFailure(record, page.failureId, leaseToken);
            await deps.previewMonitors.complete(record.row.id, leaseToken);
            return;
          }
        } catch {
          // The agent keeps the terminal failure id. A transient provider or
          // CP-13 failure is retried with the same stable event key.
        }
      }
    })().finally(() => {
      if (failureMonitors.get(record.row.id) === monitor) {
        failureMonitors.delete(record.row.id);
        void deps.previewMonitors.release(record.row.id, leaseToken);
      }
    });
  };
  const stopFailureMonitor = (workspaceId: string): void => {
    failureMonitors.get(workspaceId)?.controller.abort();
    failureMonitors.delete(workspaceId);
  };
  const acquireEnabledFailureMonitors = async (): Promise<void> => {
    for (const record of await deps.rows.listAttachments()) {
      if (
        record.row.providerWorkspaceId !== null &&
        record.row.status === 'ready' &&
        !failureMonitors.has(record.row.id)
      ) {
        await monitorTerminalPreviewFailure(record, record.row.providerWorkspaceId, false);
      }
    }
  };
  const recoverCostRecordings = async (signal: AbortSignal): Promise<void> => {
    const records = await settleOrAbort(deps.rows.listAttachments(), signal);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(8, records.length) }, async (): Promise<void> => {
      while (!signal.aborted) {
        const record = records[cursor];
        cursor += 1;
        if (record === undefined) return;
        try {
          await settleOrAbort(ensureCostRecording(record), signal);
        } catch {
          // Durable rows remain discoverable and are retried on the next pass.
        }
      }
    });
    await Promise.all(workers);
  };
  app.addHook('onReady', async () => {
    if (deps.costRecorder !== undefined) {
      costRecoveryLoop = (async () => {
        while (!costRecoveryController.signal.aborted) {
          try {
            await recoverCostRecordings(costRecoveryController.signal);
          } catch {
            // Startup/readiness does not inherit a transient provider or DB outage.
          }
          if (await waitFor(1_000, costRecoveryController.signal)) return;
        }
      })();
    }
    await acquireEnabledFailureMonitors();
    acquisitionLoop = (async () => {
      while (!acquisitionController.signal.aborted) {
        if (await waitFor(previewMonitorStandbyPollIntervalMs, acquisitionController.signal)) {
          return;
        }
        try {
          await acquireEnabledFailureMonitors();
        } catch {
          // Durable lease discovery is retried; an individual outage cannot
          // permanently strand every already-running standby replica.
        }
      }
    })();
  });
  app.addHook('onClose', async () => {
    lifecycle.closing = true;
    costRecoveryController.abort();
    acquisitionController.abort();
    await costRecoveryLoop;
    await acquisitionLoop;
    const monitors = [...failureMonitors.entries()];
    for (const { controller } of failureMonitors.values()) controller.abort();
    failureMonitors.clear();
    await Promise.all(
      monitors.map(async ([workspaceId, { leaseToken }]) => {
        await deps.previewMonitors.release(workspaceId, leaseToken);
      }),
    );
    const recordings = [...activeCostRecordings.values()];
    activeCostRecordings.clear();
    await Promise.all(recordings.map(async (recording) => recording.close()));
  });
  if (deps.storageMeasurements !== undefined) {
    app.get(
      '/internal/projects/:projectId/storage-measurement',
      {
        preHandler: app.requireService,
        schema: {
          params: ProjectParamsSchema,
          response: { 200: StorageMeasurementSchema },
        },
      },
      async (request: FastifyRequest) => {
        if (request.authenticatedServiceClaims?.service !== 'control-api') {
          throw Object.assign(new Error('Project was not found.'), { statusCode: 404 });
        }
        const { projectId } = ProjectParamsSchema.parse(request.params);
        const scope = readWorkspaceScope(request);
        if (scope.projectId !== projectId) {
          throw Object.assign(new Error('Project scope does not match the request.'), {
            statusCode: 400,
          });
        }
        return StorageMeasurementSchema.parse(
          await deps.storageMeasurements?.measureProjectBytes({
            organizationId: scope.organizationId,
            projectId,
          }),
        );
      },
    );
  }
  if (deps.checkpointService !== undefined) {
    const checkpointService = deps.checkpointService;
    app.post(
      '/internal/workspaces/:workspaceId/checkpoint',
      {
        preHandler: app.requireService,
        schema: {
          params: WorkspaceParamsSchema,
          body: CheckpointBodySchema,
          response: { 200: CheckpointResponseSchema },
        },
      },
      async (request: FastifyRequest) => {
        if (request.authenticatedServiceClaims?.service !== 'control-api') {
          throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
        }
        const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
        const body = CheckpointBodySchema.parse(request.body);
        requireIdempotencyKey(request.headers['idempotency-key'], body.operationKey);
        const row = await resolveWorkspace(workspaceId, request);
        if (row.branchId === null) {
          throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
        }
        const checkpoint = await checkpointService.checkpoint({
          organizationId: row.organizationId,
          projectId: row.projectId,
          branchId: row.branchId,
          workspaceId: row.id,
          operationKey: body.operationKey,
          kind: body.kind,
          taskBoundary: true,
          includeSnapshot: true,
        });
        return { snapshotRef: checkpoint.checkpointId };
      },
    );
  }
  app.post(
    '/internal/workspaces',
    {
      preHandler: app.requireService,
      schema: {
        body: CreateWorkspaceBodySchema,
        response: {
          200: WorkspaceResponseSchema,
          201: WorkspaceResponseSchema,
          409: BranchLockedResponseSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = CreateWorkspaceBodySchema.parse(request.body);
      requireIdempotencyKey(request.headers['idempotency-key'], body.operationKey);
      const scope = readWorkspaceScope(request);
      if (
        scope.organizationId !== body.workspace.organizationId ||
        scope.projectId !== body.workspace.projectId
      ) {
        throw Object.assign(new Error('Workspace scope does not match the request.'), {
          statusCode: 400,
        });
      }
      if (!(await deps.rows.projectOwnedBy(scope.projectId, scope.organizationId))) {
        throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
      }
      await deps.networkPolicies.record(
        NetworkPolicyRecordSchema.parse({
          operationKey: body.operationKey,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          workspaceId: body.workspace.id,
          policy: resolveNetworkPolicy(body.networkProfile, body.integrationDomains),
          providerEnforced: false,
          recordedAt: deps.now(),
        }),
      );
      const key = WorkspaceRowIdempotencyKeySchema.parse({
        runId: body.runId,
        taskId: body.taskId,
        purpose: body.purpose,
        branchId: body.workspace.branchId,
        branchName: body.branchName,
      });
      const lockedImageTag = deps.provider.imageTagForPurpose(body.purpose);
      const input = createInputFor(body.workspace, body, lockedImageTag);
      const claim = await deps.rows.claimCreate(body.workspace, key, {
        resourceProfile: body.workspace.resourceProfile,
        imageTag: lockedImageTag,
        createdAt: body.workspace.createdAt,
        requiredTags: {
          org_id: body.workspace.organizationId,
          project_id: body.workspace.projectId,
          branch_id: body.workspace.branchId,
          run_id: body.runId,
          task_id: body.taskId,
          purpose: body.purpose,
          environment: deps.provider.attachmentEnvironment,
        },
      });
      try {
        await deps.governor.admit({
          workspaceId: claim.row.id,
          organizationId: claim.row.organizationId,
          projectId: claim.row.projectId,
          runId: body.runId,
          taskId: body.taskId,
          purpose: body.purpose,
          operationKey: body.operationKey,
        });
      } catch (error) {
        if (claim.created) {
          await deps.rows.transition(claim.row.id, 'terminated', {
            terminatedAt: deps.now(),
          });
        }
        throw error;
      }
      if (!claim.created) {
        if (claim.row.status !== 'ready' || claim.row.providerWorkspaceId === null) {
          await deps.governor.release({
            workspaceId: claim.row.id,
            organizationId: claim.row.organizationId,
            operationKey: body.operationKey,
          });
          throw Object.assign(new Error('Original workspace creation did not complete.'), {
            statusCode: 502,
          });
        }
        const record = await deps.rows.getAttachment(
          claim.row.id,
          claim.row.organizationId,
          claim.row.projectId,
        );
        if (record === undefined) throw new Error('workspace attachment was not persisted');
        await ensureCostRecording(record);
        return await reply.status(200).send({ workspace: claim.row });
      }

      try {
        await deps.rows.transition(claim.row.id, 'provisioning');
      } catch (error) {
        await deps.governor.release({
          workspaceId: claim.row.id,
          organizationId: claim.row.organizationId,
          operationKey: body.operationKey,
        });
        throw error;
      }
      let untrustedHandle: WorkspaceHandle;
      try {
        untrustedHandle = await deps.provider.createWorkspace(
          input,
          async (providerWorkspaceId) => {
            await deps.rows.bindProviderWorkspaceId(
              claim.row.id,
              providerWorkspaceId,
              'provisioning',
            );
          },
        );
      } catch (error) {
        try {
          await deps.rows.transition(
            claim.row.id,
            'terminated',
            { terminatedAt: deps.now() },
            'provisioning',
          );
        } finally {
          await deps.governor.release({
            workspaceId: claim.row.id,
            organizationId: claim.row.organizationId,
            operationKey: body.operationKey,
          });
        }
        throw error;
      }
      const providerWorkspaceId = z
        .object({ providerWorkspaceId: z.string().min(1) })
        .passthrough()
        .parse(untrustedHandle).providerWorkspaceId;
      try {
        const handle = WorkspaceHandleSchema.strict().parse(untrustedHandle);
        if (
          handle.status !== 'ready' ||
          handle.imageTag !== lockedImageTag ||
          handle.resourceProfile !== claim.row.resourceProfile
        ) {
          throw new Error('Workspace provider returned a mismatched handle.');
        }
        await deps.rows.transition(claim.row.id, 'started', {
          providerWorkspaceId: handle.providerWorkspaceId,
        });
        const providerStatus = await deps.provider.getStatus(handle.providerWorkspaceId);
        if (providerStatus !== 'ready') {
          throw new Error('Workspace provider did not become ready.');
        }
        await deps.workspaceGit.bootstrap({
          organizationId: claim.row.organizationId,
          projectId: claim.row.projectId,
          branchId: RequestedWorkspaceRowSchema.parse(claim.row).branchId,
          branchName: body.branchName,
          providerWorkspaceId: handle.providerWorkspaceId,
          runId: body.runId,
          taskId: body.taskId,
          operationKey: body.operationKey,
        });
        const ready = await deps.rows.transition(claim.row.id, 'ready');
        const record = await deps.rows.getAttachment(
          ready.id,
          ready.organizationId,
          ready.projectId,
        );
        if (record === undefined) throw new Error('workspace attachment was not persisted');
        await ensureCostRecording(record, body.operationKey);
        return await reply.status(201).send({ workspace: ready });
      } catch (error) {
        await deps.provider.terminateWorkspace(providerWorkspaceId);
        if ((await deps.provider.getStatus(providerWorkspaceId)) !== 'terminated') {
          throw Object.assign(new Error('Workspace create compensation was not confirmed.'), {
            statusCode: 502,
            cause: error,
          });
        }
        try {
          await deps.rows.transition(claim.row.id, 'terminated', {
            providerWorkspaceId,
            terminatedAt: deps.now(),
          });
        } finally {
          await deps.governor.release({
            workspaceId: claim.row.id,
            organizationId: claim.row.organizationId,
            operationKey: body.operationKey,
          });
        }
        throw Object.assign(new Error('Workspace creation did not persist safely.'), {
          statusCode: 502,
          cause: error,
        });
      }
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/attach',
    {
      preHandler: app.requireService,
      schema: {
        params: WorkspaceParamsSchema,
        body: AttachBodySchema,
        response: { 200: AttachedWorkspaceResponseSchema },
      },
    },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const body = AttachBodySchema.parse(request.body);
      requireIdempotencyKey(request.headers['idempotency-key'], body.operationKey);
      const organizationId = idSchema('org').parse(request.headers['x-zapp-organization-id']);
      const projectId = idSchema('proj').parse(request.headers['x-zapp-project-id']);
      const record = await deps.rows.getAttachment(workspaceId, organizationId, projectId);
      if (record === undefined) {
        throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
      }
      let row = record.row;
      if (row.providerWorkspaceId === null) {
        row = await deps.rows.transition(row.id, 'terminated', { terminatedAt: deps.now() });
        await deps.governor.release({
          workspaceId: row.id,
          organizationId: row.organizationId,
          operationKey: body.operationKey,
        });
        throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
      }
      const providerWorkspaceId = row.providerWorkspaceId;
      if (row.status === 'terminated') {
        if ((await deps.provider.getStatus(providerWorkspaceId)) !== 'terminated') {
          await deps.provider.terminateWorkspace(providerWorkspaceId);
        }
        throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
      }
      try {
        const handle = WorkspaceHandleSchema.strict().parse(
          await deps.provider.attachWorkspace(providerWorkspaceId, record.attachment),
        );
        if (
          handle.providerWorkspaceId !== providerWorkspaceId ||
          handle.status !== 'ready' ||
          handle.resourceProfile !== row.resourceProfile ||
          handle.imageTag !== record.attachment.imageTag
        ) {
          throw new ModalWorkspaceTagMismatchError();
        }
        const providerStatus = await deps.provider.getStatus(providerWorkspaceId);
        if (providerStatus === 'terminated') {
          row = await deps.rows.transition(row.id, 'terminated', { terminatedAt: deps.now() });
          await deps.governor.release({
            workspaceId: row.id,
            organizationId: row.organizationId,
            operationKey: body.operationKey,
          });
          throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
        }
        if (providerStatus !== 'ready') {
          await deps.provider.terminateWorkspace(providerWorkspaceId);
          if ((await deps.provider.getStatus(providerWorkspaceId)) !== 'terminated') {
            throw Object.assign(new Error('Workspace readiness compensation was not confirmed.'), {
              statusCode: 502,
            });
          }
          row = await deps.rows.transition(row.id, 'terminated', { terminatedAt: deps.now() });
          await deps.governor.release({
            workspaceId: row.id,
            organizationId: row.organizationId,
            operationKey: body.operationKey,
          });
          throw Object.assign(new Error('Workspace did not remain ready.'), { statusCode: 502 });
        }
        const progression: Partial<Record<WorkspaceStatus, WorkspaceStatus>> = {
          requested: 'provisioning',
          provisioning: 'started',
          started: 'ready',
        };
        for (;;) {
          const nextStatus = progression[row.status];
          if (nextStatus === undefined) break;
          row = await deps.rows.transition(row.id, nextStatus, undefined, row.status);
        }
        if (row.status === 'terminated') {
          throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
        }
        await ensureCostRecording({ ...record, row });
        return { workspace: PublicWorkspaceLifecycleRowSchema.parse(row) };
      } catch (error) {
        if (error instanceof ModalWorkspaceTagMismatchError) {
          const terminated = await deps.rows.transition(row.id, 'terminated', {
            terminatedAt: deps.now(),
          });
          await deps.governor.release({
            workspaceId: terminated.id,
            organizationId: terminated.organizationId,
            operationKey: body.operationKey,
          });
          throw Object.assign(new Error('Workspace was not found.'), {
            statusCode: 404,
            cause: error,
          });
        }
        if (error instanceof ModalWorkspaceNotFoundError) {
          const terminated = await deps.rows.transition(row.id, 'terminated', {
            terminatedAt: deps.now(),
          });
          await deps.governor.release({
            workspaceId: terminated.id,
            organizationId: terminated.organizationId,
            operationKey: body.operationKey,
          });
          throw Object.assign(new Error('Workspace was not found.'), {
            statusCode: 404,
            cause: error,
          });
        }
        if (error instanceof ModalWorkspaceReadinessError) {
          await deps.provider.terminateWorkspace(providerWorkspaceId);
          if ((await deps.provider.getStatus(providerWorkspaceId)) !== 'terminated') {
            throw Object.assign(new Error('Workspace readiness compensation was not confirmed.'), {
              statusCode: 502,
              cause: error,
            });
          }
          const terminated = await deps.rows.transition(row.id, 'terminated', {
            terminatedAt: deps.now(),
          });
          await deps.governor.release({
            workspaceId: terminated.id,
            organizationId: terminated.organizationId,
            operationKey: body.operationKey,
          });
          throw Object.assign(new Error('Workspace did not become ready.'), {
            statusCode: 502,
            cause: error,
          });
        }
        throw error;
      }
    },
  );

  app.get(
    '/internal/workspaces/:workspaceId',
    {
      preHandler: app.requireService,
      schema: {
        params: WorkspaceParamsSchema,
        response: { 200: StatusResponseSchema },
      },
    },
    async (request: FastifyRequest) => {
      const params = WorkspaceParamsSchema.parse(request.params);
      const scope = readWorkspaceScope(request);
      const row = await deps.rows.get(params.workspaceId, scope.organizationId, scope.projectId);
      if (row === undefined) {
        throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
      }
      const providerStatus =
        row.providerWorkspaceId === null
          ? row.status
          : await deps.provider.getStatus(row.providerWorkspaceId);
      return { workspace: row, providerStatus };
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/terminate',
    {
      preHandler: app.requireService,
      schema: {
        params: WorkspaceParamsSchema,
        body: TerminateBodySchema,
        response: { 200: WorkspaceResponseSchema },
      },
    },
    async (request: FastifyRequest) => {
      const params = WorkspaceParamsSchema.parse(request.params);
      const body = TerminateBodySchema.parse(request.body);
      requireIdempotencyKey(request.headers['idempotency-key'], body.operationKey);
      const scope = readWorkspaceScope(request);
      const row = await deps.rows.get(params.workspaceId, scope.organizationId, scope.projectId);
      if (row === undefined) {
        throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
      }
      if (row.status === 'terminated') {
        await deps.previewMonitors.revoke(row.id);
        stopFailureMonitor(row.id);
        await deps.governor.release({
          workspaceId: row.id,
          organizationId: row.organizationId,
          operationKey: body.operationKey,
        });
        return { workspace: row };
      }
      if (row.providerWorkspaceId !== null) {
        let recording = activeCostRecordings.get(row.id);
        if (recording === undefined) {
          const record = await deps.rows.getAttachment(row.id, row.organizationId, row.projectId);
          if (record !== undefined) recording = await ensureCostRecording(record);
        }
        if (recording !== undefined) {
          await recording.terminate();
          activeCostRecordings.delete(row.id);
        }
        await deps.provider.terminateWorkspace(row.providerWorkspaceId);
        if ((await deps.provider.getStatus(row.providerWorkspaceId)) !== 'terminated') {
          throw Object.assign(new Error('Workspace provider termination was not confirmed.'), {
            statusCode: 502,
          });
        }
      }
      await deps.previewMonitors.revoke(row.id);
      stopFailureMonitor(row.id);
      const terminated = await deps.rows.transition(row.id, 'terminated', {
        terminatedAt: deps.now(),
      });
      await deps.governor.release({
        workspaceId: terminated.id,
        organizationId: terminated.organizationId,
        operationKey: body.operationKey,
      });
      return { workspace: terminated };
    },
  );

  app.post(
    '/internal/orgs/:organizationId/terminate-all',
    {
      preHandler: app.requireService,
      schema: {
        params: OrganizationParamsSchema,
        body: TerminateAllBodySchema,
        response: { 200: TerminateAllResponseSchema },
      },
    },
    async (request: FastifyRequest) => {
      const { organizationId } = OrganizationParamsSchema.parse(request.params);
      const body = TerminateAllBodySchema.parse(request.body);
      requireIdempotencyKey(request.headers['idempotency-key'], body.operationKey);
      if (request.authenticatedServiceClaims?.service !== 'control-api') {
        throw Object.assign(new Error('A control-api service token is required.'), {
          statusCode: 401,
        });
      }
      return TerminateAllResponseSchema.parse(
        await deps.governor.terminateAll({ organizationId, ...body }),
      );
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/exec',
    {
      preHandler: app.requireService,
      schema: { params: WorkspaceParamsSchema, querystring: ExecQuerySchema, body: ExecBodySchema },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const query = ExecQuerySchema.parse(request.query);
      const body = ExecBodySchema.parse(request.body);
      const row = await resolveWorkspace(workspaceId, request);
      const providerWorkspaceId = z.string().min(1).parse(row.providerWorkspaceId);
      const key = readIdempotencyKey(request.headers['idempotency-key']);
      let registry: SecretRegistry = {};
      let childEnvironment: Readonly<Record<string, string>> | undefined;
      if (body.secretScope !== undefined) {
        const resolved = await deps.secrets.resolve({
          organizationId: row.organizationId,
          projectId: row.projectId,
          environmentId: body.secretScope.environmentId,
          secretIds: body.secretScope.secretIds,
          reason: `launch app command in workspace ${workspaceId}`,
        });
        registry = resolved.values;
        childEnvironment = { ...resolved.values, ...resolved.agentEnvironment };
        assertSandboxEnvironment(childEnvironment, Object.keys(resolved.values));
      }
      const command = ExecCommandBodySchema.parse(body);
      const input = ExecInputSchema.parse({
        ...command,
        providerWorkspaceId,
        ...(childEnvironment === undefined ? {} : { env: childEnvironment }),
      });
      if (query.stream !== '1') {
        return ExecResultSchema.parse(
          redactExecResult(await deps.provider.exec(input, key), registry),
        );
      }
      const controller = new AbortController();
      const abort = (): void => {
        controller.abort();
      };
      request.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      const stdout = createSecretStreamRedactor(registry);
      const stderr = createSecretStreamRedactor(registry);
      try {
        for await (const untrustedRecord of deps.provider.execStream(
          input,
          key,
          controller.signal,
        )) {
          const record = ExecStreamRecordSchema.parse(untrustedRecord);
          if (reply.raw.destroyed) break;
          if (record.type === 'stdout' || record.type === 'stderr') {
            const data = (record.type === 'stdout' ? stdout : stderr).push(record.data);
            if (data !== '') reply.raw.write(`${JSON.stringify({ ...record, data })}\n`);
            continue;
          }
          if (record.type === 'exit') {
            const stdoutTail = stdout.finish();
            const stderrTail = stderr.finish();
            if (stdoutTail !== '') {
              reply.raw.write(
                `${JSON.stringify({ type: 'stdout', data: stdoutTail, at: record.at })}\n`,
              );
            }
            if (stderrTail !== '') {
              reply.raw.write(
                `${JSON.stringify({ type: 'stderr', data: stderrTail, at: record.at })}\n`,
              );
            }
          }
          reply.raw.write(`${JSON.stringify(record)}\n`);
        }
        if (!reply.raw.destroyed) reply.raw.end();
      } finally {
        request.raw.off('aborted', abort);
        reply.raw.off('close', abort);
      }
      return reply;
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/exec/:pid/kill',
    { preHandler: app.requireService, schema: { params: ExecParamsSchema, body: KillBodySchema } },
    async (request: FastifyRequest) => {
      const params = ExecParamsSchema.parse(request.params);
      const body = KillBodySchema.parse(request.body);
      return KillResponseSchema.parse(
        await deps.provider.killExec(
          await resolveProviderWorkspaceId(params.workspaceId, request),
          params.pid,
          body.executionId,
          readIdempotencyKey(request.headers['idempotency-key']),
        ),
      );
    },
  );

  app.get(
    '/internal/workspaces/:workspaceId/files',
    {
      preHandler: app.requireService,
      schema: { params: WorkspaceParamsSchema, querystring: FileQuerySchema },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const { path } = FileQuerySchema.parse(request.query);
      const body = await deps.provider.readFile(
        await resolveProviderWorkspaceId(workspaceId, request),
        path,
      );
      return reply.type('application/octet-stream').send(Buffer.from(body));
    },
  );

  app.put(
    '/internal/workspaces/:workspaceId/files',
    {
      preHandler: app.requireService,
      schema: { params: WorkspaceParamsSchema, querystring: FileQuerySchema },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const { path } = FileQuerySchema.parse(request.query);
      if (!Buffer.isBuffer(request.body)) throw new z.ZodError([]);
      await deps.provider.writeFile(
        await resolveProviderWorkspaceId(workspaceId, request),
        path,
        request.body,
        readIdempotencyKey(request.headers['idempotency-key']),
      );
      return reply.status(204).send();
    },
  );

  app.get(
    '/internal/workspaces/:workspaceId/files/list',
    {
      preHandler: app.requireService,
      schema: { params: WorkspaceParamsSchema, querystring: ListQuerySchema },
    },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const query = ListQuerySchema.parse(request.query);
      return FileListResponseSchema.parse(
        await deps.provider.listFiles(
          await resolveProviderWorkspaceId(workspaceId, request),
          query.path,
          {
            ...(query.glob === undefined ? {} : { glob: query.glob }),
            ...(query.maxDepth === undefined ? {} : { maxDepth: query.maxDepth }),
          },
        ),
      );
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/git',
    {
      preHandler: app.requireService,
      schema: { params: WorkspaceParamsSchema, body: GitBodySchema },
    },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const input = GitBodySchema.parse(request.body);
      const operationKey = readIdempotencyKey(request.headers['idempotency-key']);
      if (input.operation === 'push') {
        const row = await resolveWorkspace(workspaceId, request);
        if (row.branchId === null || row.providerWorkspaceId === null) {
          throw Object.assign(new Error('Workspace Git branch was not found.'), {
            statusCode: 404,
          });
        }
        return GitResponseSchema.parse(
          await deps.workspaceGit.push(
            {
              organizationId: row.organizationId,
              projectId: row.projectId,
              branchId: row.branchId,
              providerWorkspaceId: row.providerWorkspaceId,
              operationKey,
            },
            input.args ?? [],
          ),
        );
      }
      return GitResponseSchema.parse(
        await deps.provider.git(
          await resolveProviderWorkspaceId(workspaceId, request),
          input,
          operationKey,
        ),
      );
    },
  );

  app.get(
    '/internal/workspaces/:workspaceId/healthz',
    { preHandler: app.requireService, schema: { params: WorkspaceParamsSchema } },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      return HealthResponseSchema.parse(
        await deps.provider.health(await resolveProviderWorkspaceId(workspaceId, request)),
      );
    },
  );

  app.get(
    '/internal/workspaces/:workspaceId/metrics',
    { preHandler: app.requireService, schema: { params: WorkspaceParamsSchema } },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      return MetricsResponseSchema.parse(
        await deps.provider.metrics(await resolveProviderWorkspaceId(workspaceId, request)),
      );
    },
  );

  app.get(
    '/internal/workspaces/:workspaceId/files/update-snapshot',
    {
      preHandler: app.requireService,
      schema: { params: WorkspaceParamsSchema, querystring: FileQuerySchema },
    },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const { path } = FileQuerySchema.parse(request.query);
      return deps.provider.readFileForUpdate(
        await resolveProviderWorkspaceId(workspaceId, request),
        path,
      );
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/files/atomic-write',
    {
      preHandler: app.requireService,
      schema: { params: WorkspaceParamsSchema, body: AtomicWriteBodySchema },
    },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const body = AtomicWriteBodySchema.parse(request.body);
      await deps.provider.writeFilesAtomically(
        await resolveProviderWorkspaceId(workspaceId, request),
        body.files.map((file) => ({
          path: file.path,
          data: Buffer.from(file.dataBase64, 'base64'),
          ...(file.expectedRevision === undefined
            ? {}
            : { expectedRevision: file.expectedRevision }),
        })),
        readIdempotencyKey(request.headers['idempotency-key']),
      );
      return OkResponseSchema.parse({ ok: true });
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/search',
    {
      preHandler: app.requireService,
      schema: { params: WorkspaceParamsSchema, body: SearchBodySchema },
    },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      return ExecResultSchema.parse(
        await deps.provider.search(
          await resolveProviderWorkspaceId(workspaceId, request),
          SearchBodySchema.parse(request.body),
        ),
      );
    },
  );

  app.delete(
    '/internal/workspaces/:workspaceId/files',
    {
      preHandler: app.requireService,
      schema: { params: WorkspaceParamsSchema, querystring: FileQuerySchema },
    },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const { path } = FileQuerySchema.parse(request.query);
      const result = await deps.provider.deleteFile(
        await resolveProviderWorkspaceId(workspaceId, request),
        path,
        readIdempotencyKey(request.headers['idempotency-key']),
      );
      return DeleteResponseSchema.parse({ ok: true, alreadyAbsent: result.alreadyAbsent });
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/files/rename',
    {
      preHandler: app.requireService,
      schema: { params: WorkspaceParamsSchema, body: RenameBodySchema },
    },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      await deps.provider.renameFile(
        await resolveProviderWorkspaceId(workspaceId, request),
        RenameBodySchema.parse(request.body),
        readIdempotencyKey(request.headers['idempotency-key']),
      );
      return OkResponseSchema.parse({ ok: true });
    },
  );

  for (const action of ['start', 'restart'] as const) {
    app.post(
      `/internal/workspaces/:workspaceId/dev-server/${action}`,
      {
        preHandler: app.requireService,
        schema: { params: WorkspaceParamsSchema, body: DevServerBodySchema },
      },
      async (request: FastifyRequest) => {
        const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
        const { contract } = DevServerBodySchema.parse(request.body);
        const key = readIdempotencyKey(request.headers['idempotency-key']);
        const record = await resolveAttachment(workspaceId, request);
        const providerWorkspaceId = z.string().min(1).parse(record.row.providerWorkspaceId);
        return withObservabilitySpan(
          `preview.readiness:${action}`,
          {
            'zapp.organization.id': record.row.organizationId,
            'zapp.project.id': record.row.projectId,
            'zapp.sandbox.id': workspaceId,
          },
          async () => {
            await emitPreview(record, key, action, 'preview.starting');
            let response: z.infer<typeof DevServerResponseSchema>;
            try {
              response = DevServerResponseSchema.parse(
                await (action === 'start'
                  ? deps.provider.startDevServer(providerWorkspaceId, contract, key)
                  : deps.provider.restartDevServer(providerWorkspaceId, contract, key)),
              );
            } catch (error) {
              try {
                await emitPreview(record, key, action, 'preview.failed', {
                  code: 'dev_server_operation_failed',
                });
              } catch (eventError) {
                throw new AggregateError(
                  [error, eventError],
                  'Dev server operation and preview failure event both failed',
                );
              }
              throw error;
            }
            await monitorTerminalPreviewFailure(record, providerWorkspaceId, true);
            // Delivery failure is not a dev-server failure. The caller retries the
            // same operation key; CP-13 and the agent both replay idempotently.
            await emitPreview(record, key, action, 'preview.ready', {
              port: response.port,
              supervisorId: response.supervisorId,
            });
            return response;
          },
        );
      },
    );
  }

  app.get(
    '/internal/workspaces/:workspaceId/dev-server/logs',
    {
      preHandler: app.requireService,
      schema: { params: WorkspaceParamsSchema, querystring: DevServerLogsQuerySchema },
    },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const query = DevServerLogsQuerySchema.parse(request.query);
      const record = await resolveAttachment(workspaceId, request);
      const response = DevServerLogsResponseSchema.parse(
        await deps.provider.readDevServerLogs(
          z.string().min(1).parse(record.row.providerWorkspaceId),
          query,
        ),
      );
      return response;
    },
  );
}

export type { WorkspacePurpose };
