import { randomUUID } from 'node:crypto';

import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
  type preHandlerAsyncHookHandler,
} from 'fastify';
import websocket from '@fastify/websocket';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '@zapp/db';

import {
  createGitTokenClient,
  createWorkspaceGitService,
  type GitTokenClientOptions,
  type WorkspaceGitService,
} from './provider/git-bootstrap.js';
import { BranchLockedError } from './provider/volumes.js';
import {
  registerWorkspaceRoutes,
  type WorkspaceAgentProvider,
  type PreviewLifecycleEventPort,
  type WorkspaceRowBoundary,
  type PreviewMonitorCoordinator,
} from './routes/workspaces.js';
import type { NetworkPolicyRecorder } from './network/profiles.js';
import { createFetchPreviewTransport, type PreviewTransport } from './preview/transport.js';
import type { ScopedSecretInjector } from './secrets/injector.js';
import { registerPreviewRoutes } from './routes/preview.js';
import {
  createControlPlanePreviewEventClient,
  type ControlPlanePreviewEventClientOptions,
} from './events/client.js';
import {
  SandboxQuotaExceededError,
  type RunawayComputeGovernor,
} from './lifecycle/governor.js';
import {
  createCostRecorder,
  type CostRecorderDependencies,
  type SandboxPricing,
} from './cost/recorder.js';
import {
  createControlPlaneUsageLedgerClient,
  type ControlPlaneUsageLedgerClientOptions,
} from './cost/client.js';
import {
  createDatabaseSnapshotMeasurementStore,
  createProjectStorageMeasurementService,
  type SnapshotMeasurementStore,
} from './storage/measurements.js';
import {
  createDatabaseCostRecordingStateStore,
  type CostRecordingStateStore,
} from './cost/state.js';
import {
  createCheckpointService,
  type CheckpointServiceDependencies,
} from './checkpoint/service.js';

const SERVICE_TOKEN_HEADER = 'x-zapp-service-token';

export interface SandboxServiceTokenVerifier {
  verifyServiceToken(
    token: string,
    audience: 'sandbox-service',
    now?: Date,
  ): Promise<
    | {
        readonly ok: true;
        readonly claims: { readonly service: string; readonly audience: string };
      }
    | { readonly ok: false; readonly reason: string }
  >;
}

declare module 'fastify' {
  interface FastifyInstance {
    requireService: preHandlerAsyncHookHandler;
  }

  interface FastifyRequest {
    authenticatedServiceClaims: {
      readonly service: string;
      readonly audience: string;
    } | null;
  }
}

export type SandboxServiceApp = FastifyInstance;

interface BuildAppCommonOptions {
  readonly provider: WorkspaceAgentProvider;
  readonly rows: WorkspaceRowBoundary;
  readonly previewMonitors: PreviewMonitorCoordinator;
  readonly governor: RunawayComputeGovernor;
  readonly previewMonitorOwnerId?: string;
  readonly previewMonitorLeaseMs?: number;
  readonly previewMonitorStandbyPollIntervalMs?: number;
  readonly serviceTokens: SandboxServiceTokenVerifier;
  readonly secrets: ScopedSecretInjector;
  readonly networkPolicies: NetworkPolicyRecorder;
  readonly previewTransport?: PreviewTransport;
  readonly previewFailurePollIntervalMs?: number;
  readonly now?: () => Date;
  readonly logger?: FastifyServerOptions['logger'];
  readonly storageMeasurements?: {
    measureProjectBytes(input: {
      readonly organizationId: string;
      readonly projectId: string;
    }): Promise<unknown>;
  };
  readonly storageMetering?: { readonly database: Database };
  readonly snapshotMeasurements?: SnapshotMeasurementStore;
  readonly checkpointing?: Omit<
    CheckpointServiceDependencies,
    'now' | 'snapshots' | 'snapshotMeasurements'
  > & {
    readonly restoreSnapshot: CheckpointServiceDependencies['snapshots']['restore'];
  };
  readonly usageMetering?: {
    readonly pricing: SandboxPricing;
    readonly nowMs?: () => number;
    readonly scheduler?: CostRecorderDependencies['scheduler'];
  } & (
    | { readonly state: CostRecordingStateStore; readonly database?: never }
    | { readonly state?: never; readonly database: Database }
  ) & (
    | {
        readonly ledger: CostRecorderDependencies['ledger'];
        readonly controlPlane?: never;
      }
    | {
        readonly ledger?: never;
        readonly controlPlane: ControlPlaneUsageLedgerClientOptions;
      }
  );
}

export type BuildAppOptions = BuildAppCommonOptions &
  (
    | { readonly workspaceGit: WorkspaceGitService; readonly gitService?: never }
    | { readonly workspaceGit?: never; readonly gitService: GitTokenClientOptions }
  ) &
  (
    | {
        readonly events: PreviewLifecycleEventPort;
        readonly controlPlaneEvents?: never;
      }
    | {
        readonly events?: never;
        readonly controlPlaneEvents: ControlPlanePreviewEventClientOptions;
      }
  );

function authenticationError() {
  return { code: 'service_unauthenticated', message: 'A valid service token is required.' };
}

export function buildApp(options: BuildAppOptions) {
  const now = options.now ?? (() => new Date());
  const workspaceGit =
    options.workspaceGit ??
    createWorkspaceGitService({
      tokens: createGitTokenClient(options.gitService),
      commands: options.provider,
    });
  const events =
    options.events ?? createControlPlanePreviewEventClient(options.controlPlaneEvents);
  const snapshotMeasurements =
    options.snapshotMeasurements ??
    (options.storageMetering === undefined
      ? undefined
      : createDatabaseSnapshotMeasurementStore(options.storageMetering.database));
  const storageMeasurements =
    options.storageMeasurements ??
    (snapshotMeasurements === undefined
      ? undefined
      : createProjectStorageMeasurementService({
          snapshots: snapshotMeasurements,
          volumes: {
            measureProjectVolumeBytes(input) {
              if (options.provider.measureProjectVolumeBytes === undefined) {
                throw new Error('workspace provider cannot measure project volume bytes');
              }
              return options.provider.measureProjectVolumeBytes(input);
            },
          },
          now,
        }));
  const rawCostRecorder =
    options.usageMetering === undefined
      ? undefined
      : createCostRecorder({
          nowMs: options.usageMetering.nowMs ?? Date.now,
          metrics: { sample: (providerWorkspaceId) => options.provider.metrics(providerWorkspaceId) },
          ledger:
            options.usageMetering.ledger ??
            createControlPlaneUsageLedgerClient(options.usageMetering.controlPlane),
          state:
            options.usageMetering.state ??
            createDatabaseCostRecordingStateStore(options.usageMetering.database),
          scheduler:
            options.usageMetering.scheduler ??
            {
              setInterval: (callback, intervalMs) => setInterval(() => void callback(), intervalMs),
              clearInterval: (handle) => {
                clearInterval(handle as ReturnType<typeof setInterval>);
              },
            },
        });
  const checkpointService =
    options.checkpointing === undefined
      ? undefined
      : createCheckpointService({
          now,
          git: options.checkpointing.git,
          codec: options.checkpointing.codec,
          crypto: options.checkpointing.crypto,
          artifacts: options.checkpointing.artifacts,
          records: options.checkpointing.records,
          snapshots: {
            create: async (input) => {
              if (options.provider.snapshotWorkspace === undefined) {
                throw new Error('workspace provider cannot create snapshots');
              }
              const row = await options.rows.get(
                input.workspaceId,
                input.organizationId,
                input.projectId,
              );
              if (row?.providerWorkspaceId === null || row?.providerWorkspaceId === undefined) {
                throw new Error('workspace provider identity is unavailable for snapshot');
              }
              const created = await options.provider.snapshotWorkspace(
                row.providerWorkspaceId,
                input.ttlMs,
              );
              return {
                providerSnapshotId: created.providerSnapshotId,
                logicalBytes: created.logicalBytes,
              };
            },
            restore: options.checkpointing.restoreSnapshot,
          },
          snapshotMeasurements: snapshotMeasurements ?? {
            record() {
              throw new Error('snapshot measurement persistence is not configured');
            },
          },
        });
  const app = Fastify({
    logger: options.logger ?? false,
    requestIdHeader: false,
    trustProxy: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('authenticatedServiceClaims', null);
  void app.register(websocket);
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SandboxQuotaExceededError) {
      void reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        queuePosition: error.queuePosition,
      });
      return;
    }
    if (error instanceof BranchLockedError) {
      void reply.status(409).send({ code: error.code, message: error.message });
      return;
    }
    if ((error as { readonly code?: unknown }).code === 'atomic_write_conflict') {
      void reply.status(409).send({
        code: 'atomic_write_conflict',
        message: 'Atomic file changed before commit.',
      });
      return;
    }
    const fastifyError = error as { readonly statusCode?: number; readonly validation?: unknown };
    if (fastifyError.validation !== undefined || error instanceof z.ZodError) {
      void reply
        .status(400)
        .send({ code: 'invalid_request', message: 'Request validation failed.' });
      return;
    }
    const statusCode = fastifyError.statusCode ?? 500;
    void reply.status(statusCode).send({
      code: statusCode === 404 ? 'workspace_not_found' : 'sandbox_operation_failed',
      message:
        statusCode >= 500
          ? 'The sandbox operation failed.'
          : error instanceof Error
            ? error.message
            : 'The request failed.',
    });
  });

  app.decorate('requireService', async (request, reply) => {
    if (request.headers.authorization !== undefined || request.headers.cookie !== undefined) {
      await reply.status(401).send(authenticationError());
      return;
    }
    const raw = request.headers[SERVICE_TOKEN_HEADER];
    if (typeof raw !== 'string' || raw === '') {
      await reply.status(401).send(authenticationError());
      return;
    }
    const verdict = await options.serviceTokens.verifyServiceToken(raw, 'sandbox-service', now());
    if (
      !verdict.ok ||
      verdict.claims.audience !== 'sandbox-service' ||
      !['control-api', 'orchestrator-worker'].includes(verdict.claims.service)
    ) {
      await reply.status(401).send(authenticationError());
      return;
    }
    request.authenticatedServiceClaims = verdict.claims;
  });

  registerWorkspaceRoutes(app, {
    provider: options.provider,
    rows: options.rows,
    workspaceGit,
    secrets: options.secrets,
    networkPolicies: options.networkPolicies,
    events,
    previewMonitors: options.previewMonitors,
    governor: options.governor,
    previewMonitorOwnerId: options.previewMonitorOwnerId ?? randomUUID(),
    ...(options.previewMonitorLeaseMs === undefined
      ? {}
      : { previewMonitorLeaseMs: options.previewMonitorLeaseMs }),
    ...(options.previewMonitorStandbyPollIntervalMs === undefined
      ? {}
      : {
          previewMonitorStandbyPollIntervalMs:
            options.previewMonitorStandbyPollIntervalMs,
        }),
    ...(options.previewFailurePollIntervalMs === undefined
      ? {}
      : { previewFailurePollIntervalMs: options.previewFailurePollIntervalMs }),
    now,
    ...(storageMeasurements === undefined
      ? {}
      : { storageMeasurements }),
    ...(checkpointService === undefined ? {} : { checkpointService }),
    ...(rawCostRecorder === undefined || options.usageMetering === undefined
      ? {}
      : {
          costRecorder: {
            start: (input: object) =>
              rawCostRecorder.start({ ...input, pricing: options.usageMetering?.pricing }),
          },
        }),
  });
  const previewTransport =
    options.previewTransport ??
    createFetchPreviewTransport({
      async resolvePreviewTunnel(providerWorkspaceId) {
        if (options.provider.resolvePreviewTunnel === undefined) {
          throw new Error('Workspace provider does not support preview transport');
        }
        return options.provider.resolvePreviewTunnel(providerWorkspaceId);
      },
    });
  void app.register((previewApp, _pluginOptions, done) => {
    registerPreviewRoutes(previewApp, { rows: options.rows, transport: previewTransport });
    done();
  });
  return app;
}
