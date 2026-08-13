import { createServiceTokenSigner, defineEnv, type ServiceTokenConfig } from '@zapp/config';
import {
  DeployReleaseInputSchema as InternalDeployInputSchema,
  DeploymentResultSchema as InternalDeploymentResultSchema,
  EvidenceManifestSchema,
  ForkReleaseInputSchema,
  ForkReleaseResultSchema,
  ReadinessReportSchema,
  RollbackReleaseInputSchema as InternalRollbackInputSchema,
} from '@zapp/release-service/lifecycle';
import { ReleaseSchema as InternalReleaseSchema } from '@zapp/release-service/records';
import { ReleaseHistoryPageSchema as InternalReleaseHistoryPageSchema } from '@zapp/release-service/history';
import { DeploymentProgressSchema, DeploymentActionInputSchema } from '@zapp/release-service/deployment-progress';
import { DomainResultSchema } from '@zapp/release-service/domain-store';
import { ProductionHistorySchema } from '@zapp/release-service/production-history';
import { RollbackPreviewSchema } from '@zapp/release-service';
import { z } from 'zod';

import {
  CreateReleaseInputSchema,
  DeploymentResultSchema,
  ReadinessSchema,
  ReleaseLookupInputSchema,
  ReleaseMutationInputSchema,
  ReleaseRowSchema,
  PublicReleaseHistoryPageSchema,
  ReleaseHistoryInputSchema,
  type ReleaseForkPort,
  type ReleasePort,
} from '../routes/releases.js';

export const RELEASE_SERVICE_DEADLINE_MS = 15_000;

const ReleaseServiceEnvSchema = z.object({
  RELEASE_SERVICE_URL: z
    .union([
      z
        .string()
        .url()
        .refine((value) => /^https?:\/\//u.test(value), 'RELEASE_SERVICE_URL must be HTTP(S)'),
      z.literal(''),
    ])
    .optional(),
});

export function loadReleaseServiceUrl(source: unknown = process.env): string | undefined {
  const value = defineEnv(ReleaseServiceEnvSchema, source).RELEASE_SERVICE_URL;
  return value === undefined || value === '' ? undefined : value.replace(/\/+$/u, '');
}

export type ForkReleaseInput = z.infer<typeof ForkReleaseInputSchema>;
export type ForkReleaseResult = z.infer<typeof ForkReleaseResultSchema>;

export class ReleaseServiceClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReleaseServiceClientError';
  }
}

export interface ReleaseServiceClientOptions {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export interface ReleaseServiceClients {
  readonly release: ReleasePort;
  readonly fork: ReleaseForkPort;
}

export function createReleaseServiceClient(
  options: ReleaseServiceClientOptions,
): ReleaseServiceClients {
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));

  async function request(
    path: string,
    init: Omit<RequestInit, 'headers' | 'signal'> & {
      readonly operationKey?: string;
    } = {},
  ): Promise<unknown> {
    const { token } = await signer.signServiceToken({
      service: 'control-api',
      aud: 'release-service',
    });
    const { operationKey, ...requestInit } = init;
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        ...requestInit,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-zapp-service-token': token,
          ...(operationKey === undefined ? {} : { 'idempotency-key': operationKey }),
        },
        signal: AbortSignal.timeout(RELEASE_SERVICE_DEADLINE_MS),
      });
    } catch (error) {
      throw new ReleaseServiceClientError('the release service could not be reached', {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new ReleaseServiceClientError(
        `the release service refused the operation (${String(response.status)})`,
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new ReleaseServiceClientError('the release service returned an unreadable response', {
        cause: error,
      });
    }
  }

  const release: ReleasePort = {
    async listProjectHistory(rawInput) {
      const input = ReleaseHistoryInputSchema.parse(rawInput);
      const query = new URLSearchParams({
        organizationId: input.organizationId,
        limit: String(input.limit),
        ...(input.cursor === null ? {} : { cursor: input.cursor }),
      });
      const response = z.object({ page: InternalReleaseHistoryPageSchema }).strict().parse(
        await request(`/internal/projects/${input.projectId}/releases?${query.toString()}`),
      );
      return PublicReleaseHistoryPageSchema.parse({
        ...response.page,
        items: response.page.items.map(({ evidenceArtifactId, ...item }) => ({
          ...item,
          evidence: evidenceArtifactId === null ? null : {
            artifactId: evidenceArtifactId,
            href: `/v1/releases/${item.id}/evidence`,
          },
        })),
      });
    },
    async createReleaseCandidate(rawInput) {
      const body = CreateReleaseInputSchema.parse(rawInput);
      const response = z
        .object({ release: InternalReleaseSchema })
        .strict()
        .parse(
          await request('/internal/releases', {
            method: 'POST',
            operationKey: body.operationKey,
            body: JSON.stringify(body),
          }),
        );
      return ReleaseRowSchema.parse(response.release);
    },

    async getRelease(rawInput) {
      const input = ReleaseLookupInputSchema.parse(rawInput);
      try {
        const response = z
          .object({ release: InternalReleaseSchema })
          .strict()
          .parse(
            await request(
              `/internal/releases/${input.releaseId}?organizationId=${input.organizationId}`,
            ),
          );
        return ReleaseRowSchema.parse(response.release);
      } catch (error) {
        if (error instanceof ReleaseServiceClientError && error.message.includes('(404)')) {
          return undefined;
        }
        throw error;
      }
    },

    async getReadiness(rawInput) {
      const input = ReleaseLookupInputSchema.parse(rawInput);
      const response = z
        .object({ readiness: ReadinessReportSchema })
        .strict()
        .parse(
          await request(
            `/internal/releases/${input.releaseId}/readiness?organizationId=${input.organizationId}`,
          ),
        );
      return ReadinessSchema.parse({
        state: response.readiness.state,
        findings: response.readiness.findings,
      });
    },

    async approve(rawInput) {
      const input = ReleaseMutationInputSchema.parse(rawInput);
      const response = z
        .object({ release: InternalReleaseSchema })
        .strict()
        .parse(
          await request(`/internal/releases/${input.releaseId}/approve`, {
            method: 'POST',
            operationKey: input.operationKey,
            body: JSON.stringify({
              actor: { id: input.actorId, organizationId: input.organizationId },
              operationKey: input.operationKey,
            }),
          }),
        );
      return ReleaseRowSchema.parse(response.release);
    },

    async deploy(rawInput) {
      const input = InternalDeployInputSchema.parse(rawInput);
      return DeploymentResultSchema.parse(
        InternalDeploymentResultSchema.parse(
          await request(`/internal/releases/${input.releaseId}/deploy`, {
            method: 'POST',
            operationKey: input.operationKey,
            body: JSON.stringify({
              organizationId: input.organizationId,
              actorId: input.actorId,
              operationKey: input.operationKey,
              deploymentType: input.deploymentType,
              confirmation: input.confirmation,
            }),
          }),
        ),
      );
    },

    async rollback(rawInput) {
      const input = InternalRollbackInputSchema.parse(rawInput);
      return DeploymentResultSchema.parse(
        InternalDeploymentResultSchema.parse(
          await request(`/internal/releases/${input.releaseId}/rollback`, {
            method: 'POST',
            operationKey: input.operationKey,
            body: JSON.stringify({
              organizationId: input.organizationId,
              actorId: input.actorId,
              operationKey: input.operationKey,
              toDeploymentId: input.toDeploymentId,
              reason: input.reason,
            }),
          }),
        ),
      );
    },

    async getEvidence(rawInput) {
      const input = ReleaseLookupInputSchema.parse(rawInput);
      const response = z
        .object({ evidence: EvidenceManifestSchema })
        .strict()
        .parse(
          await request(
            `/internal/releases/${input.releaseId}/evidence?organizationId=${input.organizationId}`,
          ),
        );
      return response.evidence;
    },
    async getDeploymentProgress(rawInput) {
      const input = z.object({ organizationId: z.string().min(1), deploymentId: z.string().min(1) }).strict().parse(rawInput);
      try {
        const response = z.object({ progress: DeploymentProgressSchema }).strict().parse(
          await request(`/internal/deployments/${input.deploymentId}?organizationId=${input.organizationId}`),
        );
        return response.progress;
      } catch (error) {
        if (error instanceof ReleaseServiceClientError && error.message.includes('(404)')) return undefined;
        throw error;
      }
    },
    async act(rawInput) {
      const input = DeploymentActionInputSchema.parse(rawInput);
      const path = input.resourceType === 'release'
        ? `/internal/releases/${input.resourceId}/actions`
        : `/internal/deployments/${input.resourceId}/actions`;
      return z.object({ status: z.literal('dispatched') }).strict().parse(await request(path, {
        method: 'POST', operationKey: input.operationKey,
        body: JSON.stringify({ organizationId: input.organizationId, action: input.action, actor: input.actor, operationKey: input.operationKey, payload: input.payload }),
      }));
    },
    async listDomains(rawInput) {
      const input = z.object({ organizationId: z.string().min(1), projectId: z.string().min(1), environmentId: z.string().optional() }).strict().parse(rawInput);
      const query = new URLSearchParams({ organizationId: input.organizationId, ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }) });
      return z.object({ domains: z.array(DomainResultSchema).max(100) }).strict().parse(await request(`/internal/projects/${input.projectId}/domains?${query.toString()}`)).domains;
    },
    async configureDomain(rawInput) {
      const input = z.object({ organizationId: z.string(), projectId: z.string(), environmentId: z.string(), hostname: z.string(), operationKey: z.string() }).strict().parse(rawInput);
      return z.object({ domain: DomainResultSchema }).strict().parse(await request(`/internal/projects/${input.projectId}/domains`, { method: 'POST', operationKey: input.operationKey, body: JSON.stringify({ organizationId: input.organizationId, environmentId: input.environmentId, hostname: input.hostname, operationKey: input.operationKey }) })).domain;
    },
    async pollDomain(rawInput) {
      const input = z.object({ organizationId: z.string(), projectId: z.string(), environmentId: z.string(), hostname: z.string(), operationKey: z.string() }).strict().parse(rawInput);
      return z.object({ domain: DomainResultSchema }).strict().parse(await request(`/internal/projects/${input.projectId}/domains/${encodeURIComponent(input.hostname)}/poll`, { method: 'POST', operationKey: input.operationKey, body: JSON.stringify({ organizationId: input.organizationId, environmentId: input.environmentId, operationKey: input.operationKey }) })).domain;
    },
    async getProductionHistory(rawInput) {
      const input = z.object({ organizationId: z.string().min(1), projectId: z.string().min(1) }).strict().parse(rawInput);
      return z.object({ history: ProductionHistorySchema }).strict().parse(await request(`/internal/projects/${input.projectId}/production?organizationId=${input.organizationId}`)).history;
    },
    async getRollbackPreview(rawInput) {
      const input = z.object({ organizationId: z.string().min(1), releaseId: z.string().min(1), toDeploymentId: z.string().optional() }).strict().parse(rawInput);
      const query = new URLSearchParams({ organizationId: input.organizationId, ...(input.toDeploymentId === undefined ? {} : { toDeploymentId: input.toDeploymentId }) });
      return z.object({ preview: RollbackPreviewSchema }).strict().parse(await request(`/internal/releases/${input.releaseId}/rollback-preview?${query.toString()}`)).preview;
    },
  };

  return {
    release,
    fork: {
      async forkRelease(rawInput) {
        const input = ForkReleaseInputSchema.parse(rawInput);
        const response = z
          .object({ fork: ForkReleaseResultSchema })
          .strict()
          .parse(
            await request(`/internal/releases/${input.releaseId}/fork`, {
              method: 'POST',
              operationKey: input.operationKey,
              body: JSON.stringify({
                organizationId: input.organizationId,
                actorId: input.actorId,
                operationKey: input.operationKey,
                startFixRun: input.startFixRun,
              }),
            }),
          );
        return response.fork;
      },
    },
  };
}

function isDevelopment(): boolean {
  const value = process.env['NODE_ENV'];
  return value === 'development' || value === 'test';
}

export function resolveReleaseService(options: {
  readonly baseUrl: string | undefined;
  readonly serviceTokens: ServiceTokenConfig;
}): ReleaseServiceClients {
  if (options.baseUrl === undefined) {
    if (!isDevelopment()) {
      throw new Error(
        'refusing to start: no RELEASE_SERVICE_URL was supplied, so release lifecycle APIs would be inert',
      );
    }
    const unavailable = (): Promise<never> =>
      Promise.reject(new ReleaseServiceClientError('release service unavailable'));
    return {
      release: {
        createReleaseCandidate: unavailable,
        getRelease: unavailable,
        getReadiness: unavailable,
        approve: unavailable,
        deploy: unavailable,
        rollback: unavailable,
        getEvidence: unavailable,
      },
      fork: { forkRelease: unavailable },
    };
  }
  return createReleaseServiceClient({
    baseUrl: options.baseUrl,
    serviceTokens: options.serviceTokens,
  });
}
