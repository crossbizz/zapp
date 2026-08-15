import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { SERVICE_TOKEN_ISSUER } from '@zapp/config';
import { newId } from '@zapp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SandboxServiceEnv } from '../src/env.js';
import { registerSandboxHealthRoute } from '../src/app.js';
import {
  composeSandboxRuntime,
  type SandboxRuntimeFactories,
} from '../src/runtime.js';
import { createPostgresNetworkPolicyRecorder } from '../src/network/postgres.js';

function localDatabaseUrl(): string {
  const url = new URL('postgres://127.0.0.1:5432/zapp');
  url.username = 'zapp';
  url.password = 'zapp';
  return url.toString();
}

function environment(): SandboxServiceEnv {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 4400,
    databaseUrl: localDatabaseUrl(),
    controlApiInternalUrl: 'http://127.0.0.1:4000',
    gitServiceUrl: 'http://127.0.0.1:4500',
    gitCloneBaseUrl: 'https://git-edge.example.test/root',
    serviceTokens: { secret: 's'.repeat(64) },
    serviceTokenIssuer: SERVICE_TOKEN_ISSUER,
    provider: 'modal',
    modal: {
      environment: 'dev',
      credentials: { tokenId: 'ak-test-runtime', tokenSecret: 'as-test-runtime' },
    },
    globalLimit: 12,
    ownerId: 'sandbox-local-1',
    telemetryEnv: {},
  };
}

function harness() {
  const calls: string[] = [];
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerSandboxHealthRoute(app);
  app.addHook('onClose', () => {
    calls.push('http.close');
  });
  const database = {
    db: { kind: 'postgres' },
    close: vi.fn(() => {
      calls.push('database.close');
      return Promise.resolve();
    }),
  };
  const background = {
    run: vi.fn(async (signal: AbortSignal) => {
      calls.push('background.start');
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            calls.push('background.stop');
            resolve();
          },
          { once: true },
        );
      });
    }),
  };
  const state = { kind: 'postgres-state' };
  const provider = { kind: 'modal-provider' };
  const networkPolicies = { kind: 'postgres-network-audit' };
  const controlApi = {
    secrets: { kind: 'control-api-secrets' },
    events: { kind: 'control-api-events' },
    usage: { kind: 'control-api-usage' },
  };
  const serviceTokens = { kind: 'service-token-signer' };
  const telemetryRelay = { kind: 'telemetry-relay' };
  const pricing = { cpuSecondUsd: 0.1, memoryGibSecondUsd: 0.2, creditsPerUsd: 100 };
  const received: { compose?: unknown; provider?: unknown; controlApi?: unknown } = {};
  const factories: SandboxRuntimeFactories = {
    loadImageLock: vi.fn(() =>
      Promise.resolve({
        version: 1,
        environments: {
          dev: {
            modalEnvironment: 'zapp-dev',
            sourceRevision: 'a'.repeat(40),
            tag: '2026-08-11-aaaaaaa',
            images: {},
          },
        },
      }),
    ),
    openDatabase: vi.fn(() => database as never),
    createProvider: vi.fn((input) => {
      received.provider = input;
      return provider as never;
    }),
    createState: vi.fn(() => state as never),
    createNetworkPolicies: vi.fn(() => networkPolicies as never),
    createControlApi: vi.fn((input) => {
      received.controlApi = input;
      return controlApi as never;
    }),
    createServiceTokens: vi.fn(() => serviceTokens as never),
    createTelemetryRelay: vi.fn(() => telemetryRelay as never),
    loadPricing: vi.fn(() => Promise.resolve(pricing)),
    composeApp: vi.fn((input) => {
      received.compose = input;
      return Promise.resolve(app as never);
    }),
    createBackgroundWork: vi.fn(() => background),
  };
  return { app, background, calls, database, factories, received };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sandbox runtime composition', () => {
  it('keeps the workspace-agent credential stable across service restarts', async () => {
    const first = harness();
    const second = harness();
    const firstRuntime = await composeSandboxRuntime(environment(), first.factories);
    const secondRuntime = await composeSandboxRuntime(environment(), second.factories);

    const firstToken = (first.received.provider as { readonly agentToken: string }).agentToken;
    const secondToken = (second.received.provider as { readonly agentToken: string }).agentToken;
    expect(firstToken).toBe(secondToken);
    expect(firstToken).not.toBe(environment().serviceTokens.secret);
    expect(firstToken).toHaveLength(64);

    await firstRuntime.close();
    await secondRuntime.close();
  });

  it('binds locked Modal, PostgreSQL, scoped internal clients, shallow health, and starts once', async () => {
    const test = harness();
    const runtime = await composeSandboxRuntime(environment(), test.factories);

    const health = await runtime.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', service: 'sandbox-service' });
    expect(test.received.provider).toMatchObject({
      provider: 'modal',
      environment: 'dev',
      credentials: environment().modal.credentials,
    });
    expect(test.received.controlApi).toEqual({
      baseUrl: environment().controlApiInternalUrl,
      serviceTokens: environment().serviceTokens,
    });
    expect(test.received.compose).toMatchObject({
      database: test.database.db,
      governor: { ownerId: environment().ownerId, globalLimit: 12 },
      app: {
        provider: { kind: 'modal-provider' },
        rows: { kind: 'postgres-state' },
        previewMonitors: { kind: 'postgres-state' },
        networkPolicies: { kind: 'postgres-network-audit' },
        gitService: {
          baseUrl: environment().gitServiceUrl,
          serviceTokens: environment().serviceTokens,
        },
        dependencyDomains: ['git-edge.example.test'],
      },
    });

    runtime.startBackgroundWork();
    runtime.startBackgroundWork();
    await vi.waitFor(() => {
      expect(test.background.run).toHaveBeenCalledTimes(1);
    });
    await runtime.close();
    await runtime.close();
    expect(test.calls).toEqual([
      'background.start',
      'background.stop',
      'http.close',
      'database.close',
    ]);
  });

  it('selects Docker without forwarding absent Modal credentials', async () => {
    const test = harness();
    await composeSandboxRuntime(
      {
        ...environment(),
        provider: 'docker',
        modal: { environment: 'dev' },
      },
      test.factories,
    );

    expect(test.received.provider).toMatchObject({
      provider: 'docker',
      environment: 'dev',
    });
    expect(test.received.provider).not.toHaveProperty('credentials');
    expect(test.received.compose).not.toHaveProperty('app.usageMetering');
  });

  it('fails closed when the requested Modal environment is absent from the immutable lock', async () => {
    const test = harness();
    vi.mocked(test.factories.loadImageLock).mockResolvedValue({
      version: 1,
      environments: {},
    });
    await expect(composeSandboxRuntime(environment(), test.factories)).rejects.toThrow(
      'No immutable Modal image lock exists for dev',
    );
    expect(test.factories.openDatabase).not.toHaveBeenCalled();
  });

  it('rejects the factory seam outside tests', async () => {
    const test = harness();
    await expect(
      composeSandboxRuntime({ ...environment(), nodeEnv: 'production' }, test.factories),
    ).rejects.toThrow('testOnlyFactories may only be used when NODE_ENV=test');
  });
});

describe('sandbox PostgreSQL network audit', () => {
  it('appends one stable structured row and rejects operation-key identity conflicts', async () => {
    let stored: Record<string, unknown> | undefined;
    const database = {
      insert: () => ({
        values: (candidate: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: () => {
              if (stored !== undefined) return Promise.resolve([]);
              stored = candidate;
              return Promise.resolve([candidate]);
            },
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve(stored === undefined ? [] : [stored]) }),
        }),
      }),
    };
    const recorder = createPostgresNetworkPolicyRecorder(database as never);
    const operationKey = `op_${'b'.repeat(64)}`;
    const organizationId = newId('org');
    const projectId = newId('proj');
    const workspaceId = newId('ws');
    const record = {
      operationKey,
      organizationId,
      projectId,
      workspaceId,
      policy: {
        profile: 'dependency_install' as const,
        outboundDomains: ['github.com', 'registry.npmjs.org'],
        blockAll: false,
      },
      providerEnforced: true,
      recordedAt: new Date('2026-08-14T00:00:00.000Z'),
    };
    await recorder.record(record);
    await expect(recorder.record(record)).resolves.toBeUndefined();
    expect(stored).toMatchObject({
      organizationId,
      actorType: 'service',
      actorId: 'sandbox-service',
      action: 'workspace.created',
      targetType: 'workspace',
      targetId: workspaceId,
      metadataJson: {
        recordKind: 'network_policy_applied',
        operationKey,
        projectId,
        profile: 'dependency_install',
        providerEnforced: true,
      },
    });
    await expect(
      recorder.record({ ...record, workspaceId: newId('ws') }),
    ).rejects.toThrow('conflicting identity');
  });
});
