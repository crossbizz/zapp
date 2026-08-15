import { createHash } from 'node:crypto';

import {
  BuilderPreviewDevServerResponseSchema,
  BuilderPreviewLogsResponseSchema,
  idSchema,
} from '@zapp/contracts';
import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import { z } from 'zod';

import type { SandboxStorageMeasurementPort } from '../usage/collectors/storage.js';

import {
  CheckpointWorkspaceInputSchema,
  CheckpointWorkspaceResultSchema,
  CreateWorkspaceInputSchema,
  CreateWorkspaceResultSchema,
  ReadBuilderPreviewLogsInputSchema,
  RestartBuilderPreviewInputSchema,
  SandboxServiceError,
  StartWorkspaceInputSchema,
  StartWorkspaceResultSchema,
  SupportTerminateWorkspaceResultSchema,
  TerminateOrganizationInputSchema,
  TerminateOrganizationResultSchema,
  TerminateWorkspaceInputSchema,
  type BuilderPreviewSandboxPort,
  type SandboxServicePort,
  type SupportSandboxServicePort,
} from './port.js';

const REQUEST_DEADLINE_MS = 10_000;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function lifecycleId(prefix: 'run' | 'task', value: string): string {
  const bytes = createHash('sha256').update(value).digest();
  let bits = 0;
  let accumulator = 0;
  let output = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < 26) {
      bits -= 5;
      output += CROCKFORD.charAt((accumulator >>> bits) & 31);
    }
    if (output.length === 26) break;
  }
  return `${prefix}_${output}`;
}

const StorageProjectSchema = z
  .object({ organizationId: idSchema('org'), projectId: idSchema('proj') })
  .strict();
const StorageMeasurementSchema = z
  .object({
    snapshotBytes: z.string().regex(/^\d+$/u),
    volumeBytes: z.string().regex(/^\d+$/u),
  })
  .strict();

export interface BuilderPreviewSandboxClientOptions {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

const LifecycleWorkspaceResponseSchema = z
  .object({
    workspace: z
      .object({
        providerWorkspaceId: z.string().min(1).nullable(),
        status: z.string().min(1),
      })
      .passthrough(),
  })
  .strict();

/** Shipping CP-9 lifecycle bridge used by the public workspace recovery API. */
export function createSandboxServiceClient(
  options: BuilderPreviewSandboxClientOptions,
): SandboxServicePort {
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  const headersFor = async (
    workspace: { readonly organizationId: string; readonly projectId: string },
    operationKey: string,
  ): Promise<Record<string, string>> => {
    const { token } = await signer.signServiceToken({
      service: 'control-api',
      aud: 'sandbox-service',
    });
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': operationKey,
      'x-zapp-service-token': token,
      'x-zapp-organization-id': workspace.organizationId,
      'x-zapp-project-id': workspace.projectId,
    };
  };

  const post = async (
    path: string,
    workspace: { readonly organizationId: string; readonly projectId: string },
    operationKey: string,
    body: unknown,
  ): Promise<unknown> => {
    const response = await request(doFetch, `${baseUrl}${path}`, {
      method: 'POST',
      headers: await headersFor(workspace, operationKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
    });
    return await readableJson(response);
  };

  return {
    async createWorkspace(untrustedInput) {
      const input = CreateWorkspaceInputSchema.parse(untrustedInput);
      if (input.workspace.branchId === null || input.branchName === undefined) {
        throw new SandboxServiceError();
      }
      const workspaceRow = { ...input.workspace, runId: undefined };
      const result = LifecycleWorkspaceResponseSchema.parse(
        await post('/internal/workspaces', input.workspace, input.operationKey, {
          workspace: workspaceRow,
          branchName: input.branchName,
          runId: lifecycleId('run', `workspace:${input.workspace.id}`),
          taskId: lifecycleId('task', `workspace:${input.workspace.id}`),
          purpose: 'builder',
          env: {},
          networkProfile: 'dependency_install',
          integrationDomains: [],
          operationKey: input.operationKey,
        }),
      );
      return CreateWorkspaceResultSchema.parse({
        providerWorkspaceId: result.workspace.providerWorkspaceId,
        status: result.workspace.status,
      });
    },

    async startWorkspace(untrustedInput) {
      const input = StartWorkspaceInputSchema.parse(untrustedInput);
      const result = LifecycleWorkspaceResponseSchema.parse(
        await post(
          `/internal/workspaces/${encodeURIComponent(input.workspace.id)}/attach`,
          input.workspace,
          input.operationKey,
          { operationKey: input.operationKey },
        ),
      );
      return StartWorkspaceResultSchema.parse({ status: result.workspace.status });
    },

    async checkpointWorkspace(untrustedInput) {
      const input = CheckpointWorkspaceInputSchema.parse(untrustedInput);
      return CheckpointWorkspaceResultSchema.parse(
        await post(
          `/internal/workspaces/${encodeURIComponent(input.workspace.id)}/checkpoint`,
          input.workspace,
          input.operationKey,
          { kind: input.kind, operationKey: input.operationKey },
        ),
      );
    },

    async terminateWorkspace(untrustedInput) {
      const input = TerminateWorkspaceInputSchema.parse(untrustedInput);
      LifecycleWorkspaceResponseSchema.parse(
        await post(
          `/internal/workspaces/${encodeURIComponent(input.workspace.id)}/terminate`,
          input.workspace,
          input.operationKey,
          { operationKey: input.operationKey },
        ),
      );
    },
  };
}

export function createSandboxStorageMeasurementClient(
  options: BuilderPreviewSandboxClientOptions,
): SandboxStorageMeasurementPort {
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    async measureProjectBytes(rawProject) {
      const project = StorageProjectSchema.parse(rawProject);
      const { token } = await signer.signServiceToken({
        service: 'control-api',
        aud: 'sandbox-service',
      });
      const response = await request(
        doFetch,
        `${baseUrl}/internal/projects/${project.projectId}/storage-measurement`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'x-zapp-service-token': token,
            'x-zapp-organization-id': project.organizationId,
            'x-zapp-project-id': project.projectId,
          },
          signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
        },
      );
      return StorageMeasurementSchema.parse(await readableJson(response));
    },
  };
}

/** Service-authenticated bridge; no sandbox credential or private URL reaches a browser. */
export function createBuilderPreviewSandboxClient(
  options: BuilderPreviewSandboxClientOptions,
): BuilderPreviewSandboxPort {
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  const headersFor = async (input: {
    readonly workspace: { readonly organizationId: string; readonly projectId: string };
  }): Promise<Record<string, string>> => {
    const { token } = await signer.signServiceToken({
      service: 'control-api',
      aud: 'sandbox-service',
    });
    return {
      accept: 'application/json',
      'x-zapp-service-token': token,
      'x-zapp-organization-id': input.workspace.organizationId,
      'x-zapp-project-id': input.workspace.projectId,
    };
  };

  return {
    async readDevServerLogs(untrustedInput) {
      const input = ReadBuilderPreviewLogsInputSchema.parse(untrustedInput);
      const query = new URLSearchParams({
        after: String(input.after),
        limit: String(input.limit),
      });
      const response = await request(
        doFetch,
        `${baseUrl}/internal/workspaces/${input.workspace.id}/dev-server/logs?${query.toString()}`,
        {
          method: 'GET',
          headers: await headersFor(input),
          signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
        },
      );
      return BuilderPreviewLogsResponseSchema.parse(await readableJson(response));
    },

    async restartDevServer(untrustedInput) {
      const input = RestartBuilderPreviewInputSchema.parse(untrustedInput);
      if (input.workspace.runId === null) throw new SandboxServiceError();
      const response = await request(
        doFetch,
        `${baseUrl}/internal/workspaces/${input.workspace.id}/dev-server/restart`,
        {
          method: 'POST',
          headers: {
            ...(await headersFor(input)),
            'content-type': 'application/json',
            'idempotency-key': input.operationKey,
            'x-zapp-run-id': input.workspace.runId,
          },
          body: JSON.stringify({ contract: input.contract }),
          signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
        },
      );
      return BuilderPreviewDevServerResponseSchema.parse(await readableJson(response));
    },
  };
}

const TerminatedWorkspaceResponseSchema = z
  .object({
    workspace: z
      .object({ status: z.literal('terminated'), terminatedAt: z.coerce.date() })
      .passthrough(),
  })
  .strict();

/** Service-authenticated support bridge to WS-15's audited kill boundaries. */
export function createSupportSandboxClient(
  options: BuilderPreviewSandboxClientOptions,
): SupportSandboxServicePort {
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  const token = async (): Promise<string> =>
    (
      await signer.signServiceToken({
        service: 'control-api',
        aud: 'sandbox-service',
      })
    ).token;

  return {
    async terminateWorkspace(untrustedInput) {
      const input = TerminateWorkspaceInputSchema.parse(untrustedInput);
      const response = await request(
        doFetch,
        `${baseUrl}/internal/workspaces/${input.workspace.id}/terminate`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'idempotency-key': input.operationKey,
            'x-zapp-organization-id': input.workspace.organizationId,
            'x-zapp-project-id': input.workspace.projectId,
            'x-zapp-service-token': await token(),
          },
          body: JSON.stringify({ operationKey: input.operationKey }),
          signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
        },
      );
      const result = TerminatedWorkspaceResponseSchema.parse(await readableJson(response));
      return SupportTerminateWorkspaceResultSchema.parse(result.workspace);
    },

    async terminateOrganization(untrustedInput) {
      const input = TerminateOrganizationInputSchema.parse(untrustedInput);
      const response = await request(
        doFetch,
        `${baseUrl}/internal/orgs/${input.organizationId}/terminate-all`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'idempotency-key': input.operationKey,
            'x-zapp-service-token': await token(),
          },
          body: JSON.stringify({
            actorUserId: input.actorUserId,
            reason: input.reason,
            operationKey: input.operationKey,
          }),
          signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
        },
      );
      return TerminateOrganizationResultSchema.parse(await readableJson(response));
    },
  };
}

async function request(
  doFetch: (input: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await doFetch(url, init);
  } catch (error) {
    throw new SandboxServiceError({ cause: error });
  }
  if (!response.ok) throw new SandboxServiceError();
  return response;
}

async function readableJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new SandboxServiceError({ cause: error });
  }
}
