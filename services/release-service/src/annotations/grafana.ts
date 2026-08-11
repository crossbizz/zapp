import { createHash } from 'node:crypto';

import { CommitShaSchema, HttpsUrlSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

const OperationKeySchema = z.string().trim().min(8).max(400);
const IsoDateTimeSchema = z.string().datetime({ offset: true });
const DashboardUidSchema = z.string().trim().min(1).max(256);

const GrafanaConnectionSchema = z
  .object({
    status: z.literal('connected'),
    apiBaseUrl: HttpsUrlSchema,
    credentialRef: z.string().trim().min(1).max(2_048),
    dashboards: z
      .array(
        z
          .object({
            uid: DashboardUidSchema,
            url: HttpsUrlSchema,
          })
          .strict(),
      )
      .max(100),
    faro: z
      .object({
        appId: z.string().trim().min(1).max(256),
        appUrl: HttpsUrlSchema,
        apiBaseUrl: HttpsUrlSchema,
        stackId: z.string().trim().min(1).max(128),
        credentialRef: z.string().trim().min(1).max(2_048),
      })
      .strict(),
  })
  .strict()
  .superRefine((connection, context) => {
    const dashboardUids = connection.dashboards.map(({ uid }) => uid);
    if (new Set(dashboardUids).size !== dashboardUids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dashboards'],
        message: 'grafana_duplicate_dashboard_uid',
      });
    }
  });
type GrafanaConnection = z.infer<typeof GrafanaConnectionSchema>;

const GrafanaCredentialSchema = z.object({ token: z.string().trim().min(1) }).strict();

export const GrafanaReleaseAnnotationInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    releaseId: idSchema('rel'),
    commitSha: CommitShaSchema,
    deployedAt: IsoDateTimeSchema,
    operationKey: OperationKeySchema,
  })
  .strict();
export type GrafanaReleaseAnnotationInput = z.infer<typeof GrafanaReleaseAnnotationInputSchema>;

const GrafanaAnnotationResponseSchema = z
  .object({
    message: z.string().trim().min(1),
    id: z.number().int().positive(),
  })
  .passthrough();

export const GrafanaReleaseAnnotationResultSchema = z
  .object({
    dashboardLinks: z.array(HttpsUrlSchema).max(100),
    faroAppLink: HttpsUrlSchema,
    annotationIds: z.array(z.number().int().positive()).max(100),
  })
  .strict();
export type GrafanaReleaseAnnotationResult = z.infer<typeof GrafanaReleaseAnnotationResultSchema>;

export const FaroSourceMapUploadInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    releaseId: idSchema('rel'),
    bundleId: z.string().trim().min(1).max(2_048),
    sourceMap: z.string().trim().min(1).max(50_000_000),
    operationKey: OperationKeySchema,
  })
  .strict();
export type FaroSourceMapUploadInput = z.infer<typeof FaroSourceMapUploadInputSchema>;

const SourceMapSchema = z
  .object({
    version: z.literal(3),
  })
  .passthrough();

export const FaroSourceMapUploadResultSchema = z
  .object({
    appLink: HttpsUrlSchema,
    bundleId: z.string().trim().min(1).max(2_048),
  })
  .strict();
export type FaroSourceMapUploadResult = z.infer<typeof FaroSourceMapUploadResultSchema>;

const KeyedMutationInputSchema = z
  .object({
    key: z.string().trim().min(8).max(512),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
type KeyedMutationInput = z.infer<typeof KeyedMutationInputSchema>;

export interface GrafanaAnnotationDependencies {
  readonly connection: {
    resolve(input: {
      readonly organizationId: string;
      readonly projectId: string;
    }): Promise<unknown>;
  };
  readonly vault: {
    resolveCredential(input: {
      readonly organizationId: string;
      readonly projectId: string;
      readonly credentialRef: string;
      readonly reason: 'grafana_release_annotation' | 'faro_sourcemap_upload';
    }): Promise<unknown>;
  };
  readonly mutations: {
    runOnce(input: KeyedMutationInput, mutation: () => Promise<unknown>): Promise<unknown>;
  };
  readonly fetch?: typeof fetch;
}

export class GrafanaAnnotationError extends Error {
  constructor(
    readonly code:
      | 'grafana_api_error'
      | 'grafana_invalid_connection'
      | 'grafana_invalid_credential'
      | 'grafana_invalid_response'
      | 'faro_invalid_sourcemap',
    message: string,
  ) {
    super(message);
    this.name = 'GrafanaAnnotationError';
  }
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function dashboardMutationKey(operationKey: string, dashboardUid: string): string {
  const readableKey = `${operationKey}:grafana:${dashboardUid}`;
  return readableKey.length <= 512
    ? readableKey
    : `${operationKey}:grafana:${fingerprint(dashboardUid)}`;
}

async function resolveConnection(
  dependencies: GrafanaAnnotationDependencies,
  input: { readonly organizationId: string; readonly projectId: string },
): Promise<GrafanaConnection> {
  try {
    return GrafanaConnectionSchema.parse(await dependencies.connection.resolve(input));
  } catch {
    throw new GrafanaAnnotationError(
      'grafana_invalid_connection',
      'Grafana project connection is invalid.',
    );
  }
}

async function resolveToken(
  dependencies: GrafanaAnnotationDependencies,
  input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly credentialRef: string;
    readonly reason: 'grafana_release_annotation' | 'faro_sourcemap_upload';
  },
): Promise<string> {
  try {
    return GrafanaCredentialSchema.parse(await dependencies.vault.resolveCredential(input)).token;
  } catch {
    throw new GrafanaAnnotationError(
      'grafana_invalid_credential',
      'Grafana credential resolution failed.',
    );
  }
}

export function createGrafanaReleaseAnnotationService(
  dependencies: GrafanaAnnotationDependencies,
): {
  annotate(input: GrafanaReleaseAnnotationInput): Promise<GrafanaReleaseAnnotationResult>;
} {
  const request = dependencies.fetch ?? globalThis.fetch;

  return {
    async annotate(inputValue) {
      const input = GrafanaReleaseAnnotationInputSchema.parse(inputValue);
      const connection = await resolveConnection(dependencies, input);
      const token = await resolveToken(dependencies, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        credentialRef: connection.credentialRef,
        reason: 'grafana_release_annotation',
      });
      const annotationUrl = `${withoutTrailingSlash(connection.apiBaseUrl)}/api/annotations`;

      const annotationIds = await Promise.all(
        connection.dashboards.map(async (dashboard) => {
          const body = {
            dashboardUID: dashboard.uid,
            time: Date.parse(input.deployedAt),
            tags: [`release:${input.releaseId}`, input.commitSha],
            text: `release ${input.releaseId}`,
          };
          const mutationInput = KeyedMutationInputSchema.parse({
            key: dashboardMutationKey(input.operationKey, dashboard.uid),
            fingerprint: fingerprint({ annotationUrl, body }),
          });
          const result = await dependencies.mutations.runOnce(mutationInput, async () => {
            const providerResponse = await request(annotationUrl, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify(body),
            });
            if (providerResponse.status !== 200) {
              throw new GrafanaAnnotationError(
                'grafana_api_error',
                `Grafana annotation request failed with status ${String(providerResponse.status)}.`,
              );
            }
            try {
              return GrafanaAnnotationResponseSchema.parse(await providerResponse.json());
            } catch {
              throw new GrafanaAnnotationError(
                'grafana_invalid_response',
                'Grafana annotation response is invalid.',
              );
            }
          });
          return GrafanaAnnotationResponseSchema.parse(result).id;
        }),
      );

      return GrafanaReleaseAnnotationResultSchema.parse({
        dashboardLinks: connection.dashboards.map(({ url }) => url),
        faroAppLink: connection.faro.appUrl,
        annotationIds,
      });
    },
  };
}

export function createFaroSourceMapUploadHook(dependencies: GrafanaAnnotationDependencies): {
  upload(input: FaroSourceMapUploadInput): Promise<FaroSourceMapUploadResult>;
} {
  const request = dependencies.fetch ?? globalThis.fetch;

  return {
    async upload(inputValue) {
      const input = FaroSourceMapUploadInputSchema.parse(inputValue);
      let sourceMap: z.infer<typeof SourceMapSchema>;
      try {
        sourceMap = SourceMapSchema.parse(JSON.parse(input.sourceMap));
      } catch {
        throw new GrafanaAnnotationError(
          'faro_invalid_sourcemap',
          'Faro sourcemap must be valid Source Map v3 JSON.',
        );
      }
      const connection = await resolveConnection(dependencies, input);
      const token = await resolveToken(dependencies, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        credentialRef: connection.faro.credentialRef,
        reason: 'faro_sourcemap_upload',
      });
      const uploadUrl = `${withoutTrailingSlash(connection.faro.apiBaseUrl)}/faro/api/v1/app/${encodeURIComponent(connection.faro.appId)}/sourcemaps/${encodeURIComponent(input.bundleId)}`;
      const body = JSON.stringify(sourceMap);
      const mutationInput = KeyedMutationInputSchema.parse({
        key: `${input.operationKey}:faro_sourcemap`,
        fingerprint: fingerprint({ uploadUrl, body }),
      });

      const result = await dependencies.mutations.runOnce(mutationInput, async () => {
        const providerResponse = await request(uploadUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.faro.stackId}:${token}`,
            'content-type': 'application/json',
          },
          body,
        });
        if (!providerResponse.ok) {
          throw new GrafanaAnnotationError(
            'grafana_api_error',
            `Faro sourcemap request failed with status ${String(providerResponse.status)}.`,
          );
        }
        return FaroSourceMapUploadResultSchema.parse({
          appLink: connection.faro.appUrl,
          bundleId: input.bundleId,
        });
      });

      return FaroSourceMapUploadResultSchema.parse(result);
    },
  };
}
