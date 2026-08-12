import { createServiceTokenSigner, type ServiceName, type ServiceTokenConfig } from '@zapp/config';
import { SignedVerificationArtifactSchema } from '@zapp/verification-engine';

import {
  BuilderArtifactServiceError,
  CommitComparisonSchema,
  FileEditResponseSchema,
  FileListResponseSchema,
  FileReadResponseSchema,
  TestRunsResponseSchema,
  type BuilderArtifactPort,
} from '../routes/builder-artifacts.js';

const REQUEST_DEADLINE_MS = 10_000;

export interface BuilderArtifactClientOptions {
  readonly sandboxBaseUrl: string;
  readonly gitBaseUrl: string;
  readonly verificationBaseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export function createBuilderArtifactClient(options: BuilderArtifactClientOptions): BuilderArtifactPort {
  const sandboxBaseUrl = options.sandboxBaseUrl.replace(/\/+$/u, '');
  const gitBaseUrl = options.gitBaseUrl.replace(/\/+$/u, '');
  const verificationBaseUrl = options.verificationBaseUrl.replace(/\/+$/u, '');
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const token = async (aud: ServiceName): Promise<string> =>
    (await signer.signServiceToken({ service: 'control-api', aud })).token;
  const sandboxHeaders = async (input: { readonly organizationId: string; readonly projectId: string }) => ({
    accept: 'application/json',
    'x-zapp-service-token': await token('sandbox-service'),
    'x-zapp-organization-id': input.organizationId,
    'x-zapp-project-id': input.projectId,
  });

  return {
    async listFiles(input) {
      const query = new URLSearchParams({ path: input.path });
      if (input.glob !== undefined) query.set('glob', input.glob);
      if (input.maxDepth !== undefined) query.set('maxDepth', String(input.maxDepth));
      return FileListResponseSchema.parse(await requestJson(
        doFetch,
        `${sandboxBaseUrl}/internal/workspaces/${encodeURIComponent(input.workspaceId)}/editor/files?${query.toString()}`,
        { method: 'GET', headers: await sandboxHeaders(input) },
      ));
    },
    async readFile(input) {
      const query = new URLSearchParams({ path: input.path });
      return FileReadResponseSchema.parse(await requestJson(
        doFetch,
        `${sandboxBaseUrl}/internal/workspaces/${encodeURIComponent(input.workspaceId)}/editor/file?${query.toString()}`,
        { method: 'GET', headers: await sandboxHeaders(input) },
      ));
    },
    async editFile(input) {
      return FileEditResponseSchema.parse(await requestJson(
        doFetch,
        `${sandboxBaseUrl}/internal/workspaces/${encodeURIComponent(input.workspaceId)}/editor/edits`,
        {
          method: 'POST',
          headers: {
            ...await sandboxHeaders(input),
            'content-type': 'application/json',
            'idempotency-key': input.operationKey,
          },
          body: JSON.stringify({
            path: input.path,
            dataBase64: input.dataBase64,
            expectedCompareToken: input.expectedCompareToken,
            actorUserId: input.actorUserId,
          }),
        },
      ));
    },
    async compareCommits(input) {
      const query = new URLSearchParams({ before: input.beforeSha, after: input.afterSha });
      return CommitComparisonSchema.parse(await requestJson(
        doFetch,
        `${gitBaseUrl}/internal/git/repositories/${encodeURIComponent(input.organizationId)}/${encodeURIComponent(input.projectId)}/compare?${query.toString()}`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'x-zapp-service-token': await token('git-service'),
          },
        },
      ));
    },
    async listTests(input) {
      return TestRunsResponseSchema.parse(await requestJson(
        doFetch,
        `${verificationBaseUrl}/internal/verification/organizations/${encodeURIComponent(input.organizationId)}/runs/${encodeURIComponent(input.runId)}/tests`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'x-zapp-service-token': await token('verification-service'),
          },
        },
      ));
    },
    async signEvidence(input) {
      const query = new URLSearchParams();
      if (input.taskId !== null) query.set('taskId', input.taskId);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      return SignedVerificationArtifactSchema.parse(await requestJson(
        doFetch,
        `${verificationBaseUrl}/internal/verification/organizations/${encodeURIComponent(input.organizationId)}/runs/${encodeURIComponent(input.runId)}/artifacts/${encodeURIComponent(input.artifactId)}${suffix}`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'x-zapp-service-token': await token('verification-service'),
          },
        },
      ));
    },
  };
}

async function requestJson(
  doFetch: (input: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_DEADLINE_MS) });
  } catch (cause) {
    throw new BuilderArtifactServiceError('unavailable', { cause });
  }
  if (!response.ok) {
    if (response.status === 404) throw new BuilderArtifactServiceError('not_found');
    if (response.status === 409) throw new BuilderArtifactServiceError('conflict');
    throw new BuilderArtifactServiceError('unavailable');
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new BuilderArtifactServiceError('unavailable', { cause });
  }
}
