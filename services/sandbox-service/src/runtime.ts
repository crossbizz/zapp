import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  createServiceTokenSigner,
  type ServiceTokenConfig,
  type ServiceTokenSigner,
} from '@zapp/config';
import { AuditRecordSchema } from '@zapp/contracts';
import { createDb, type Database, type Db } from '@zapp/db';
import { z } from 'zod';

import { composeSandboxApp } from './compose.js';
import { createSandboxControlApiClients } from './internal/control-api.js';
import type {
  GovernorTerminationCandidate,
  RunawayComputeGovernorDependencies,
} from './lifecycle/governor.js';
import {
  appendIdempotentSandboxAudit,
  createPostgresNetworkPolicyRecorder,
} from './network/postgres.js';
import { createModalSandboxProvider } from './provider/modal.js';
import type { WorkspaceAgentProvider } from './routes/workspaces.js';
import {
  createGrafanaSandboxTelemetryRelayFromEnv,
  type SandboxTelemetryRelay,
} from './routes/telemetry.js';
import { createPostgresWorkspaceStateStore } from './state/postgres.js';
import type { SandboxServiceEnv } from './env.js';

const ImageLockSelectionSchema = z
  .object({
    version: z.literal(1),
    environments: z.record(
      z.enum(['dev', 'staging', 'prod']),
      z
        .object({
          modalEnvironment: z.enum(['zapp-dev', 'zapp-staging', 'zapp-prod']),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const RuntimePricingSchema = z
  .object({
    creditsPerUsd: z.string().regex(/^\d+(?:\.\d+)?$/u),
    usageRates: z
      .object({
        sandbox_cpu_seconds: z.object({ usdPerUnit: z.string() }).passthrough(),
        sandbox_mem_gib_seconds: z.object({ usdPerUnit: z.string() }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough()
  .transform((value) => ({
    cpuSecondUsd: Number(value.usageRates.sandbox_cpu_seconds.usdPerUnit),
    memoryGibSecondUsd: Number(value.usageRates.sandbox_mem_gib_seconds.usdPerUnit),
    creditsPerUsd: Number(value.creditsPerUsd),
  }))
  .refine(
    (value) => Object.values(value).every((entry) => Number.isFinite(entry) && entry >= 0),
    'Sandbox pricing must contain finite non-negative rates',
  );

const SHUTDOWN_STEP_TIMEOUT_MS = 10_000;

type WorkspaceState = ReturnType<typeof createPostgresWorkspaceStateStore>;
type ControlApiClients = ReturnType<typeof createSandboxControlApiClients>;
type ProviderOptions = Parameters<typeof createModalSandboxProvider>[0];
type ComposeOptions = Parameters<typeof composeSandboxApp>[0];
type SandboxPricing = z.infer<typeof RuntimePricingSchema>;

interface BackgroundWork {
  run(signal: AbortSignal): Promise<void>;
}

export interface SandboxRuntimeFactories {
  readonly loadImageLock: () => Promise<unknown>;
  readonly openDatabase: (url: string) => Db;
  readonly createProvider: (input: ProviderOptions) => WorkspaceAgentProvider;
  readonly createState: (database: Database) => WorkspaceState;
  readonly createNetworkPolicies: (
    database: Database,
  ) => ReturnType<typeof createPostgresNetworkPolicyRecorder>;
  readonly createControlApi: (input: {
    readonly baseUrl: string;
    readonly serviceTokens: ServiceTokenConfig;
  }) => ControlApiClients;
  readonly createServiceTokens: (config: ServiceTokenConfig) => ServiceTokenSigner;
  readonly createTelemetryRelay: (input: {
    readonly agentToken: string;
    readonly env: SandboxServiceEnv;
  }) => SandboxTelemetryRelay;
  readonly loadPricing: () => Promise<SandboxPricing>;
  readonly composeApp: (input: ComposeOptions) => Promise<Awaited<ReturnType<typeof composeSandboxApp>>>;
  readonly createBackgroundWork: (input: {
    readonly rows: WorkspaceState;
    readonly provider: WorkspaceAgentProvider;
  }) => BackgroundWork;
}

export interface SandboxRuntime {
  readonly app: Awaited<ReturnType<typeof composeSandboxApp>>;
  startBackgroundWork(): void;
  close(): Promise<void>;
}

function workspaceAgentToken(serviceTokenSecret: string): string {
  return createHmac('sha256', serviceTokenSecret)
    .update('zapp-workspace-agent-token:v1')
    .digest('hex');
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} exceeded the shutdown deadline`));
        }, SHUTDOWN_STEP_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function createAttachmentBackgroundWork(input: {
  readonly rows: WorkspaceState;
  readonly provider: WorkspaceAgentProvider;
}): BackgroundWork {
  return {
    async run(signal) {
      while (!signal.aborted) {
        try {
          for (const record of await input.rows.listAttachments()) {
            if (record.row.providerWorkspaceId === null) continue;
            const status = await input.provider.getStatus(record.row.providerWorkspaceId);
            if (status === 'terminated') {
              await input.rows.transition(
                record.row.id,
                'terminated',
                { terminatedAt: new Date() },
                record.row.status,
              );
            }
          }
        } catch {
          // Durable attachments remain discoverable; the next bounded pass retries them.
        }
        await delay(30_000, signal);
      }
    },
  };
}

function disabledDevelopmentTelemetryRelay(): SandboxTelemetryRelay {
  return {
    authorized: () => false,
    forwardMetrics: () => Promise.reject(new Error('Grafana OTLP is not configured')),
  };
}

const productionFactories: SandboxRuntimeFactories = {
  async loadImageLock() {
    const source = await readFile(
      new URL('../../../infra/modal/images.lock.json', import.meta.url),
      'utf8',
    );
    return JSON.parse(source) as unknown;
  },
  openDatabase: createDb,
  createProvider: createModalSandboxProvider,
  createState: createPostgresWorkspaceStateStore,
  createNetworkPolicies: createPostgresNetworkPolicyRecorder,
  createControlApi: createSandboxControlApiClients,
  createServiceTokens: createServiceTokenSigner,
  createTelemetryRelay({ agentToken, env }) {
    const endpoint = env.telemetryEnv['GRAFANA_OTLP_ENDPOINT'];
    const token = env.telemetryEnv['GRAFANA_OTLP_TOKEN'];
    if (
      env.nodeEnv !== 'production' &&
      (endpoint === undefined || token === undefined || token === 'replace-me')
    ) {
      return disabledDevelopmentTelemetryRelay();
    }
    return createGrafanaSandboxTelemetryRelayFromEnv({
      agentToken,
      env: env.telemetryEnv,
    });
  },
  async loadPricing() {
    const source = await readFile(
      new URL('../../../config/pricing.json', import.meta.url),
      'utf8',
    );
    return RuntimePricingSchema.parse(JSON.parse(source) as unknown);
  },
  composeApp: composeSandboxApp,
  createBackgroundWork: createAttachmentBackgroundWork,
};

async function terminateCandidate(
  rows: WorkspaceState,
  provider: WorkspaceAgentProvider,
  candidate: GovernorTerminationCandidate,
): Promise<void> {
  const row = await rows.get(
    candidate.workspaceId,
    candidate.organizationId,
    candidate.projectId,
  );
  if (row === undefined || row.providerWorkspaceId === null || row.status === 'terminated') return;
  await provider.terminateWorkspace(row.providerWorkspaceId);
  await rows.transition(
    row.id,
    'terminated',
    { terminatedAt: new Date() },
    row.status,
  );
}

export async function composeSandboxRuntime(
  env: SandboxServiceEnv,
  testOnlyFactories?: SandboxRuntimeFactories,
): Promise<SandboxRuntime> {
  if (testOnlyFactories !== undefined && env.nodeEnv !== 'test') {
    throw new Error('testOnlyFactories may only be used when NODE_ENV=test');
  }
  const factories = testOnlyFactories ?? productionFactories;
  const imageLock = await factories.loadImageLock();
  const lock = ImageLockSelectionSchema.parse(imageLock);
  const lockedEnvironment = lock.environments[env.modal.environment];
  if (lockedEnvironment === undefined) {
    throw new Error(
      `No immutable Modal image lock exists for ${env.modal.environment}`,
    );
  }
  const expectedModalEnvironment = `zapp-${env.modal.environment}`;
  if (lockedEnvironment.modalEnvironment !== expectedModalEnvironment) {
    throw new Error(
      `Immutable Modal image environment does not match ${env.modal.environment}`,
    );
  }

  const databaseHandle = factories.openDatabase(env.databaseUrl);
  try {
    const database = databaseHandle.db;
    const rows = factories.createState(database);
    // Workspaces outlive an individual sandbox-service process. Deriving a
    // domain-separated credential from the stable service secret lets a
    // restarted process continue managing agents it created previously,
    // without storing or exposing the service secret itself.
    const agentToken = workspaceAgentToken(env.serviceTokens.secret);
    const provider = factories.createProvider({
      environment: env.modal.environment,
      imageLock,
      credentials: env.modal.credentials,
      agentToken,
    });
    const serviceTokens = factories.createServiceTokens(env.serviceTokens);
    const controlApi = factories.createControlApi({
      baseUrl: env.controlApiInternalUrl,
      serviceTokens: env.serviceTokens,
    });
    const networkPolicies = factories.createNetworkPolicies(database);
    const pricing = await factories.loadPricing();
    const telemetryRelay = factories.createTelemetryRelay({
      agentToken,
      env,
    });
    const governorActions: RunawayComputeGovernorDependencies['actions'] = {
      async checkpointAndTerminate(candidate) {
        await terminateCandidate(rows, provider, candidate);
      },
      async terminate(candidate) {
        await terminateCandidate(rows, provider, candidate);
      },
    };
    const app = await factories.composeApp({
      database,
      governor: {
        ownerId: env.ownerId,
        globalLimit: env.globalLimit,
        now: () => new Date(),
        actions: governorActions,
        audit: {
          async recordTerminateAll(input) {
            const record = AuditRecordSchema.parse({
              organizationId: input.organizationId,
              actorType: 'user',
              actorId: input.actorUserId,
              action: 'workspace.terminate_requested',
              targetType: 'organization',
              targetId: input.organizationId,
              metadata: { operationKey: input.operationKey, reason: input.reason },
              occurredAt: new Date(),
            });
            await appendIdempotentSandboxAudit(
              database,
              input.operationKey,
              'terminate-all',
              record,
            );
          },
        },
        scheduler: {
          setInterval: (callback, milliseconds) =>
            setInterval(() => void callback(), milliseconds),
          clearInterval: (handle) => {
            clearInterval(handle as ReturnType<typeof setInterval>);
          },
        },
      },
      app: {
        provider,
        rows,
        previewMonitors: rows,
        serviceTokens,
        secrets: controlApi.secrets,
        networkPolicies,
        events: controlApi.events,
        gitService: { baseUrl: env.gitServiceUrl, serviceTokens: env.serviceTokens },
        dependencyDomains: [new URL(env.gitCloneBaseUrl).hostname],
        telemetryRelay,
        storageMetering: { database },
        usageMetering: { pricing, database, ledger: controlApi.usage },
      },
    });
    const backgroundWork = factories.createBackgroundWork({ rows, provider });
    const controller = new AbortController();
    let backgroundPromise: Promise<void> | undefined;
    let closePromise: Promise<void> | undefined;
    return {
      app,
      startBackgroundWork() {
        backgroundPromise ??= backgroundWork.run(controller.signal);
      },
      close() {
        closePromise ??= (async () => {
          controller.abort();
          try {
            if (backgroundPromise !== undefined) {
              await bounded(backgroundPromise, 'sandbox background work');
            }
          } finally {
            try {
              await bounded(app.close(), 'sandbox HTTP close');
            } finally {
              await bounded(databaseHandle.close(), 'sandbox database close');
            }
          }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    await databaseHandle.close();
    throw error;
  }
}
