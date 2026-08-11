import {
  BuilderPreviewDevServerResponseSchema,
  BuilderPreviewLogsResponseSchema,
} from '@zapp/contracts';
import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';

import {
  ReadBuilderPreviewLogsInputSchema,
  RestartBuilderPreviewInputSchema,
  SandboxServiceError,
  type BuilderPreviewSandboxPort,
} from './port.js';

const REQUEST_DEADLINE_MS = 10_000;

export interface BuilderPreviewSandboxClientOptions {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
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
