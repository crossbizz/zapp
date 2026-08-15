import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setImmediate as waitForImmediate } from 'node:timers/promises';

import { NativeConnection, type Worker } from '@temporalio/worker';
import { createFeatureFlagEvaluator, createServiceTokenSigner } from '@zapp/config';
import { idSchema, WorkspaceStatusSchema } from '@zapp/contracts';
import { agentRuns, branches, createDb, type Database, type Db, workspaces } from '@zapp/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import {
  createDatabaseApprovalActivities,
  type ApprovalActivities,
} from '../activities/approvals.js';
import {
  createEventActivities,
  EventBatchClient,
  type EventActivities,
} from '../activities/events.js';
import { createFeatureFlagActivities } from '../activities/feature-flags.js';
import { createSessionActivities, type SessionActivities } from '../activities/session.js';
import { createWorkspaceActivities, type WorkspaceActivities } from '../activities/workspace.js';
import type { ProductionRunActivities } from '../worker.js';
import { createProductionRunWorker, TASK_QUEUES } from '../worker.js';
import type { RunWorkerEnv } from '../env.js';
import { createM1BuilderSessionRunner, type RolePromptRegistry } from './m1-session.js';
import { createModelGatewaySessionGateway } from './model-gateway-client.js';
import { createSandboxWorkspaceRuntime } from './sandbox-client.js';

const WorkspaceResponseSchema = z
  .object({ workspace: z.object({ id: idSchema('ws') }).passthrough() })
  .strict();
const ReusableWorkspaceStatusResponseSchema = z
  .object({
    workspace: z
      .object({ id: idSchema('ws'), status: z.literal('ready') })
      .passthrough(),
    providerStatus: WorkspaceStatusSchema,
  })
  .strict();
const WorkspaceGitBootstrapFailureResponseSchema = z.object({
  code: z.literal('workspace_git_bootstrap_failed'),
  details: z.object({
    stage: z.string().regex(/^[a-z-]+$/u),
    exitCode: z.number().int(),
    reason: z.enum([
      'authentication_failed',
      'connection_failed',
      'dns_resolution_failed',
      'git_command_failed',
      'repository_not_found',
      'tls_failed',
    ]),
  }),
});
const RUN_TASK_ID = idSchema('task').parse(`task_${'0'.repeat(26)}`);
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

interface WorkerPort {
  run(): Promise<void>;
  shutdown(): void;
  getState(): ReturnType<Worker['getState']>;
}

export interface RunWorkerRuntime {
  run(onReady?: () => void | Promise<void>): Promise<void>;
  shutdown(): Promise<void>;
}

export interface RunWorkerComposition {
  readonly createDatabase?: (url: string) => Db;
  readonly connectTemporal?: (options: { readonly address: string }) => Promise<NativeConnection>;
  readonly composeActivities?: (options: {
    readonly env: RunWorkerEnv;
    readonly database: Database;
  }) => ProductionRunActivities;
  readonly createWorker?: typeof createProductionRunWorker;
}

function operationKey(value: string): string {
  return `op_${createHash('sha256').update(value).digest('hex')}`;
}

function stableId(prefix: 'ws' | 'task', value: string): string {
  const bytes = createHash('sha256').update(value).digest();
  let bits = 0;
  let accumulator = 0;
  let output = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < 26) {
      bits -= 5;
      output += CROCKFORD[(accumulator >>> bits) & 31] ?? '';
    }
    if (output.length === 26) break;
  }
  return idSchema(prefix).parse(`${prefix}_${output}`);
}

function responseError(boundary: string, status: number): Error {
  return new Error(`${boundary} request failed with status ${String(status)}`);
}

export async function responseErrorFromResponse(
  boundary: string,
  response: Response,
): Promise<Error> {
  let classified: z.infer<typeof WorkspaceGitBootstrapFailureResponseSchema> | undefined;
  if (response.headers.get('content-type')?.includes('application/json') === true) {
    try {
      const parsed = WorkspaceGitBootstrapFailureResponseSchema.safeParse(await response.json());
      if (parsed.success) classified = parsed.data;
    } catch {
      // A malformed or unclassified downstream response remains a status-only error.
    }
  }
  await response.body?.cancel().catch(() => undefined);
  if (classified === undefined) return responseError(boundary, response.status);
  const { stage, exitCode, reason } = classified.details;
  return new Error(
    `${boundary} request failed with status ${String(response.status)} (${classified.code}: ${stage}/${reason}/${String(exitCode)})`,
  );
}

async function readPrompts(): Promise<RolePromptRegistry> {
  const names = ['builder', 'planner', 'verifier', 'summarizer'] as const;
  const entries = await Promise.all(
    names.map(
      async (name) =>
        [
          name,
          await readFile(
            new URL(`../../../../packages/agent-policies/prompts/${name}.md`, import.meta.url),
            'utf8',
          ),
        ] as const,
    ),
  );
  return Object.fromEntries(entries) as RolePromptRegistry;
}

async function serviceHeaders(
  env: RunWorkerEnv,
  audience: 'control-api:events.ingest' | 'sandbox-service',
  scope?: { readonly organizationId: string; readonly projectId: string },
): Promise<Headers> {
  const issued = await createServiceTokenSigner(env.serviceTokens).signServiceToken({
    service: 'orchestrator-worker',
    aud: audience,
  });
  return new Headers({
    'content-type': 'application/json',
    'x-zapp-service-token': issued.token,
    ...(scope === undefined
      ? {}
      : {
          'x-zapp-organization-id': scope.organizationId,
          'x-zapp-project-id': scope.projectId,
        }),
  });
}

const GENERATED_WORKSPACE_DIRECTORIES = new Set([
  '.cache',
  '.next',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

function isProjectSourcePath(path: string): boolean {
  const segments = path.split('/');
  if (segments.some((segment) => GENERATED_WORKSPACE_DIRECTORIES.has(segment))) return false;
  return !path.endsWith('.tsbuildinfo');
}

export async function composeProductionActivities(options: {
  readonly env: RunWorkerEnv;
  readonly database: Database;
  readonly fetchImpl?: typeof fetch;
}): Promise<ProductionRunActivities> {
  const { env, database } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const prompts = await readPrompts();
  const eventClient = new EventBatchClient({
    async publish(batch) {
      const first = batch.events[0];
      if (first === undefined) throw new Error('Event batch is empty');
      const headers = await serviceHeaders(env, 'control-api:events.ingest');
      headers.set('idempotency-key', batch.idempotencyKey);
      const response = await fetchImpl(
        `${env.controlApiInternalUrl}/internal/runs/${encodeURIComponent(first.runId)}/events`,
        { method: 'POST', headers, body: JSON.stringify(batch.events) },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw responseError('Control API event ingestion', response.status);
      }
      await response.body?.cancel().catch(() => undefined);
    },
  });
  const eventActivities: EventActivities = createEventActivities({
    client: eventClient,
    assistantContent: {
      store: () =>
        Promise.reject(
          new Error(
            'M1 assistant content exceeded the inline event limit; artifact storage is unavailable',
          ),
        ),
    },
    async transitionStatus(input) {
      const terminal =
        input.status === 'completed' || input.status === 'failed' || input.status === 'cancelled';
      const [updated] = await database
        .update(agentRuns)
        .set({ status: input.status, completedAt: terminal ? new Date() : null })
        .where(eq(agentRuns.id, input.runId))
        .returning({ id: agentRuns.id });
      if (updated === undefined) throw new Error('Run status transition target was not found');
    },
  });
  const workspaceActivities: WorkspaceActivities = createWorkspaceActivities({
    async ensureWorkspace(input) {
      if (input.branchId === null) throw new Error('The M1 Builder requires a branch');
      const [row] = await database
        .select({ name: branches.name, startedAt: agentRuns.startedAt })
        .from(agentRuns)
        .innerJoin(
          branches,
          and(
            eq(branches.id, input.branchId),
            eq(branches.organizationId, input.organizationId),
            eq(branches.projectId, input.projectId),
          ),
        )
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.organizationId, input.organizationId),
            eq(agentRuns.projectId, input.projectId),
            eq(agentRuns.branchId, input.branchId),
          ),
        )
        .limit(1);
      if (row === undefined) throw new Error('Run branch was not found in the tenant scope');
      const [reusable] = await database
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.organizationId, input.organizationId),
            eq(workspaces.projectId, input.projectId),
            eq(workspaces.branchId, input.branchId),
            eq(workspaces.status, 'ready'),
            isNull(workspaces.terminatedAt),
          ),
        )
        .orderBy(desc(workspaces.createdAt))
        .limit(1);
      if (reusable !== undefined) {
        const statusResponse = await fetchImpl(
          `${env.sandboxServiceUrl}/internal/workspaces/${encodeURIComponent(reusable.id)}`,
          {
            method: 'GET',
            headers: await serviceHeaders(env, 'sandbox-service', input),
          },
        );
        if (statusResponse.ok) {
          const status = ReusableWorkspaceStatusResponseSchema.parse(
            await statusResponse.json(),
          );
          if (status.providerStatus === 'ready') {
            return { workspaceId: status.workspace.id };
          }
          const staleKey = operationKey(
            `${input.idempotencyKey}:retire:${status.workspace.id}`,
          );
          const staleHeaders = await serviceHeaders(env, 'sandbox-service', input);
          staleHeaders.set('idempotency-key', staleKey);
          const terminationResponse = await fetchImpl(
            `${env.sandboxServiceUrl}/internal/workspaces/${encodeURIComponent(status.workspace.id)}/terminate`,
            {
              method: 'POST',
              headers: staleHeaders,
              body: JSON.stringify({ operationKey: staleKey }),
            },
          );
          if (!terminationResponse.ok) {
            throw await responseErrorFromResponse(
              'Stale sandbox workspace termination',
              terminationResponse,
            );
          }
          WorkspaceResponseSchema.parse(await terminationResponse.json());
        } else {
          await statusResponse.body?.cancel().catch(() => undefined);
          if (statusResponse.status !== 404) {
            throw responseError('Sandbox workspace status', statusResponse.status);
          }
        }
      }
      const workspaceId = stableId('ws', input.idempotencyKey);
      const taskId = stableId('task', `${input.runId}:${RUN_TASK_ID}`);
      const key = operationKey(input.idempotencyKey);
      const headers = await serviceHeaders(env, 'sandbox-service', input);
      headers.set('idempotency-key', key);
      const response = await fetchImpl(`${env.sandboxServiceUrl}/internal/workspaces`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          workspace: {
            id: workspaceId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            branchId: input.branchId,
            provider: env.sandboxProvider,
            providerWorkspaceId: null,
            status: 'requested',
            resourceProfile: 'standard',
            snapshotRef: null,
            createdAt: row.startedAt.toISOString(),
            lastActiveAt: null,
            terminatedAt: null,
          },
          branchName: row.name,
          runId: input.runId,
          taskId,
          purpose: 'builder',
          env: {},
          networkProfile: 'dependency_install',
          integrationDomains: [],
          operationKey: key,
        }),
      });
      if (!response.ok) {
        throw await responseErrorFromResponse('Sandbox workspace provisioning', response);
      }
      return {
        workspaceId: WorkspaceResponseSchema.parse(await response.json()).workspace.id,
      };
    },
    async commitAndPush(input) {
      const runtime = createSandboxWorkspaceRuntime({
        baseUrl: env.sandboxServiceUrl,
        serviceTokens: env.serviceTokens,
        organizationId: input.organizationId,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        runId: input.runId,
      });
      const changed = await runtime.git({ operation: 'diff', args: ['--name-only'] });
      if (changed.exitCode !== 0) throw new Error('Unable to inspect the workspace diff');
      const untracked = await runtime.exec({
        cmd: 'git',
        args: ['ls-files', '--others', '--exclude-standard'],
        timeoutMs: 30_000,
      });
      if (untracked.exitCode !== 0) throw new Error('Unable to inspect untracked workspace files');
      const paths = [changed.stdout, untracked.stdout]
        .flatMap((output) => output.split('\n'))
        .map((path) => path.trim())
        .filter((path) => path.length > 0)
        .filter(isProjectSourcePath)
        .filter((path, index, all) => all.indexOf(path) === index);
      if (paths.length > 0) {
        const committed = await runtime.git({
          operation: 'add_commit',
          paths,
          message: input.message,
        });
        if (committed.exitCode !== 0) throw new Error('Unable to commit the workspace changes');
      }
      const head = await runtime.exec({
        cmd: 'git',
        args: ['rev-parse', 'HEAD'],
        timeoutMs: 30_000,
      });
      if (head.exitCode !== 0) throw new Error('Unable to resolve the workspace commit');
      const commitSha = z
        .string()
        .regex(/^[0-9a-f]{40,64}$/u)
        .parse(head.stdout.trim());
      if (paths.length > 0) {
        const pushed = await runtime.git({ operation: 'push' });
        if (pushed.exitCode !== 0) throw new Error('Unable to push the workspace commit');
      }
      return {
        commitSha,
        diffstat: paths.map((path) => ({ path, additions: 0, deletions: 0 })),
      };
    },
  });
  const approvalActivities: ApprovalActivities = createDatabaseApprovalActivities({
    database,
    estimateRunCost: (input) =>
      Promise.resolve({ estimatedCredits: `${String(input.maxCredits)}.0000` }),
    checkpointBudgetStop: () =>
      Promise.reject(new Error('M1 budget checkpoints require a control-plane checkpoint port')),
  });
  const sessionActivities: SessionActivities = createSessionActivities(
    {
      async run(input, context) {
        const runtime = createSandboxWorkspaceRuntime({
          baseUrl: env.sandboxServiceUrl,
          serviceTokens: env.serviceTokens,
          organizationId: input.organizationId,
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          runId: input.runId,
        });
        return await createM1BuilderSessionRunner({
          gateway: createModelGatewaySessionGateway({
            baseUrl: env.modelGatewayUrl,
            serviceTokens: env.serviceTokens,
            fetch: fetchImpl,
          }),
          runtime,
          events: { emit: () => Promise.resolve() },
          approvals: { status: () => Promise.resolve('pending') },
          prompts,
          redactor: {
            redact(value) {
              return value.split(env.serviceTokens.secret).join('[REDACTED]');
            },
          },
          tokenCounter: {
            countRequestTokens(request) {
              return Math.max(1, Math.ceil(JSON.stringify(request).length / 4));
            },
          },
        }).run(input, context);
      },
    },
    { publishSessionEvent: (event) => eventClient.emit(event) },
  );
  const featureFlagActivities = createFeatureFlagActivities(
    createFeatureFlagEvaluator({
      provider: { evaluate: () => Promise.resolve(false) },
    }),
  );
  return {
    ...eventActivities,
    ...workspaceActivities,
    ...approvalActivities,
    ...sessionActivities,
    ...featureFlagActivities,
  } as ProductionRunActivities;
}

async function waitUntilRunning(worker: WorkerPort): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = worker.getState();
    if (state === 'RUNNING') return;
    if (state === 'FAILED' || state === 'STOPPED') {
      throw new Error(`Temporal worker stopped before readiness (${state})`);
    }
    await waitForImmediate();
  }
  throw new Error('Temporal worker did not enter RUNNING state');
}

export async function composeRunWorker(
  env: RunWorkerEnv,
  composition: RunWorkerComposition = {},
): Promise<RunWorkerRuntime> {
  if (env.workflowProfile !== 'm1' || env.nodeEnv !== 'development') {
    throw new TypeError('The local run worker requires the explicit development M1 profile');
  }
  const createDatabase = composition.createDatabase ?? createDb;
  const connectTemporal =
    composition.connectTemporal ??
    ((options: { readonly address: string }) => NativeConnection.connect(options));
  const createWorker = composition.createWorker ?? createProductionRunWorker;
  const database = createDatabase(env.databaseUrl);
  let connection: NativeConnection;
  try {
    connection = await connectTemporal({ address: env.temporalAddress });
  } catch (error: unknown) {
    await database.close();
    throw error;
  }
  let worker: WorkerPort;
  try {
    const activities =
      composition.composeActivities?.({ env, database: database.db }) ??
      (await composeProductionActivities({ env, database: database.db }));
    worker = await createWorker({
      connection,
      activities,
      database: database.db,
      taskQueue: TASK_QUEUES.agentRuns,
      namespace: env.temporalNamespace,
    });
  } catch (error: unknown) {
    await connection.close();
    await database.close();
    throw error;
  }

  let runPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const closeResources = (): Promise<void> => {
    closePromise ??= (async () => {
      await connection.close();
      await database.close();
    })();
    return closePromise;
  };

  return {
    run(onReady = () => undefined) {
      if (runPromise !== undefined) return runPromise;
      const workerRun = worker.run();
      runPromise = (async () => {
        try {
          await waitUntilRunning(worker);
          await onReady();
          await workerRun;
        } finally {
          await closeResources();
        }
      })();
      return runPromise;
    },
    shutdown() {
      shutdownPromise ??= (async () => {
        if (runPromise === undefined) {
          await closeResources();
          return;
        }
        worker.shutdown();
        await runPromise;
      })();
      return shutdownPromise;
    },
  };
}
