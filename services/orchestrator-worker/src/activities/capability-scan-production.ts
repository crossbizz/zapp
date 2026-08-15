import { createHash } from 'node:crypto';

import { PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import type { DetectionContext } from '@zapp/contracts';
import {
  CapabilityScanInputSchema,
  type CapabilityScanInput,
} from '@zapp/project-adapters';
import { z } from 'zod';

import {
  createCapabilityScanActivities,
  type CapabilityScanActivities,
  type CapabilityScanReportStore,
  type CapabilityScanWorkspace,
  type CapabilityScanWorkspacePort,
} from './capability-scan.js';

const SERVICE_TOKEN_HEADER = 'x-zapp-service-token';
const ORGANIZATION_HEADER = 'x-zapp-organization-id';
const PROJECT_HEADER = 'x-zapp-project-id';

const CreatedWorkspaceSchema = z
  .object({ workspace: z.object({ id: z.string().regex(/^ws_[0-9A-HJKMNP-TV-Z]{26}$/u) }).passthrough() })
  .strict();
const ListedFilesSchema = z.array(
  z.object({ path: z.string(), type: z.enum(['file', 'directory', 'symlink']) }).strict(),
);

export interface CapabilityScanObjectClient {
  send(command: PutObjectCommand): Promise<unknown>;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function operationKey(kind: 'create' | 'terminate', workspaceId: string, scanId: string): string {
  return `op_${createHash('sha256').update(`${kind}\0${workspaceId}\0${scanId}`).digest('hex')}`;
}

function responseOrThrow(response: Response, operation: string): Response {
  if (!response.ok) {
    throw new Error(`Capability scan ${operation} failed with HTTP ${String(response.status)}`);
  }
  return response;
}

export function createSandboxCapabilityScanWorkspacePort(options: {
  readonly baseUrl: string;
  readonly provider: 'modal' | 'docker';
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: Fetch;
  readonly now?: () => Date;
}): CapabilityScanWorkspacePort {
  const baseUrl = z.string().url().parse(options.baseUrl).replace(/\/+$/u, '');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const signer = createServiceTokenSigner(options.serviceTokens);

  const request = async (
    input: CapabilityScanInput,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const { token } = await signer.signServiceToken({
      service: 'orchestrator-worker',
      aud: 'sandbox-service',
      now: now(),
    });
    return await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        [SERVICE_TOKEN_HEADER]: token,
        [ORGANIZATION_HEADER]: input.organizationId,
        [PROJECT_HEADER]: input.projectId,
      },
    });
  };

  return {
    async open(untrustedInput) {
      const input = CapabilityScanInputSchema.parse(untrustedInput);
      const createKey = operationKey('create', input.workspaceId, input.scanId);
      const createResponse = responseOrThrow(
        await request(input, '/internal/workspaces', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': createKey,
          },
          body: JSON.stringify({
            workspace: {
              id: input.workspaceId,
              organizationId: input.organizationId,
              projectId: input.projectId,
              branchId: input.branchId,
              provider: options.provider,
              providerWorkspaceId: null,
              status: 'requested',
              resourceProfile: 'small',
              snapshotRef: null,
              createdAt: input.workspaceCreatedAt,
              lastActiveAt: null,
              terminatedAt: null,
            },
            branchName: input.branchName,
            runId: input.runId,
            taskId: input.taskId,
            purpose: 'scan',
            env: {},
            networkProfile: 'restricted_verification',
            integrationDomains: [],
            operationKey: createKey,
          }),
        }),
        'workspace creation',
      );
      const created = CreatedWorkspaceSchema.parse(await createResponse.json());
      let closed = false;
      const workspace: CapabilityScanWorkspace = {
        workspaceRoot: '.',
        async listFiles(glob) {
          const query = new URLSearchParams({ path: '.', maxDepth: '100' });
          if (glob !== '**/*') query.set('glob', glob);
          const response = responseOrThrow(
            await request(
              input,
              `/internal/workspaces/${encodeURIComponent(created.workspace.id)}/files/list?${query.toString()}`,
            ),
            'file listing',
          );
          return ListedFilesSchema.parse(await response.json())
            .filter(({ type }) => type === 'file')
            .map(({ path }) => path);
        },
        async readFile(path) {
          const query = new URLSearchParams({ path });
          const response = responseOrThrow(
            await request(
              input,
              `/internal/workspaces/${encodeURIComponent(created.workspace.id)}/files?${query.toString()}`,
            ),
            'file read',
          );
          return new TextDecoder('utf-8', { fatal: true }).decode(await response.arrayBuffer());
        },
        async close() {
          if (closed) return;
          const terminateKey = operationKey('terminate', created.workspace.id, input.scanId);
          responseOrThrow(
            await request(
              input,
              `/internal/workspaces/${encodeURIComponent(created.workspace.id)}/terminate`,
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'idempotency-key': terminateKey,
                },
                body: JSON.stringify({ operationKey: terminateKey }),
              },
            ),
            'workspace termination',
          );
          closed = true;
        },
      } satisfies DetectionContext & CapabilityScanWorkspace;
      return workspace;
    },
  };
}

export function createR2CapabilityScanReportStore(options: {
  readonly client: CapabilityScanObjectClient;
  readonly bucket: string;
}): CapabilityScanReportStore {
  const bucket = z.string().trim().min(3).max(255).parse(options.bucket);
  return {
    async put(input) {
      await options.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: input.storageRef,
          Body: input.body,
          ContentType: 'application/json',
          Metadata: { sha256: input.contentHash },
        }),
      );
    },
  };
}

export function createCapabilityScanObjectClient(config: S3ClientConfig): S3Client {
  return new S3Client(config);
}

export function createProductionCapabilityScanActivities(options: {
  readonly sandbox: Parameters<typeof createSandboxCapabilityScanWorkspacePort>[0];
  readonly artifacts: Parameters<typeof createR2CapabilityScanReportStore>[0];
}): CapabilityScanActivities {
  return createCapabilityScanActivities({
    workspaces: createSandboxCapabilityScanWorkspacePort(options.sandbox),
    reports: createR2CapabilityScanReportStore(options.artifacts),
  });
}
