import {
  BuilderPreviewDevServerResponseSchema,
  BuilderPreviewLogsResponseSchema,
  idSchema,
} from '@zapp/contracts';
import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import { z } from 'zod';

import type { SandboxStorageMeasurementPort } from '../usage/collectors/storage.js';

import {
  ReadBuilderPreviewLogsInputSchema,
  RestartBuilderPreviewInputSchema,
  SandboxServiceError,
  SupportTerminateWorkspaceResultSchema,
  TerminateOrganizationInputSchema,
  TerminateOrganizationResultSchema,
  TerminateWorkspaceInputSchema,
  type BuilderPreviewSandboxPort,
  type SupportSandboxServicePort,
} from './port.js';

const REQUEST_DEADLINE_MS = 10_000;

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
      const response = await request(
        doFetch,
        `${baseUrl}/internal/workspaces/${input.workspace.id}/dev-server/restart`,
        {
          method: 'POST',
          headers: {
            ...(await headersFor(input)),
            'content-type': 'application/json',
            'idempotency-key': input.operationKey,
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
