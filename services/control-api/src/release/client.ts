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
import { z } from 'zod';

import {
  CreateReleaseInputSchema,
  DeploymentResultSchema,
  ReadinessSchema,
  ReleaseLookupInputSchema,
  ReleaseMutationInputSchema,
  ReleaseRowSchema,
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
