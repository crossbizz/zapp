import { createHash } from 'node:crypto';

import { CommitShaSchema, HttpsUrlSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

const OperationKeySchema = z.string().trim().min(8).max(400);
const IsoDateTimeSchema = z.string().datetime({ offset: true });

const PostHogConnectionSchema = z
  .object({
    status: z.literal('connected'),
    apiBaseUrl: HttpsUrlSchema,
    projectId: z.number().int().positive(),
    credentialRef: z.string().trim().min(1).max(2_048),
  })
  .strict();
type PostHogConnection = z.infer<typeof PostHogConnectionSchema>;

const PostHogCredentialSchema = z.object({ token: z.string().trim().min(1) }).strict();

export const PostHogReleaseAnnotationInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    releaseId: idSchema('rel'),
    commitSha: CommitShaSchema,
    deployedAt: IsoDateTimeSchema,
    operationKey: OperationKeySchema,
  })
  .strict();
export type PostHogReleaseAnnotationInput = z.infer<typeof PostHogReleaseAnnotationInputSchema>;

const PostHogAnnotationResponseSchema = z
  .object({
    id: z.number().int().positive(),
    content: z.string().nullable().optional(),
    date_marker: IsoDateTimeSchema.nullable().optional(),
    scope: z.enum(['project', 'organization', 'dashboard', 'dashboard_item']).optional(),
  })
  .passthrough();

export const PostHogReleaseAnnotationResultSchema = z
  .object({
    annotationId: z.number().int().positive(),
    annotationLink: HttpsUrlSchema,
  })
  .strict();
export type PostHogReleaseAnnotationResult = z.infer<typeof PostHogReleaseAnnotationResultSchema>;

const KeyedMutationInputSchema = z
  .object({
    key: z.string().trim().min(8).max(512),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
type KeyedMutationInput = z.infer<typeof KeyedMutationInputSchema>;

export interface PostHogAnnotationDependencies {
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
      readonly reason: 'posthog_release_annotation';
    }): Promise<unknown>;
  };
  readonly mutations: {
    runOnce(input: KeyedMutationInput, mutation: () => Promise<unknown>): Promise<unknown>;
  };
  readonly fetch?: typeof fetch;
}

export class PostHogAnnotationError extends Error {
  constructor(
    readonly code:
      | 'posthog_api_error'
      | 'posthog_invalid_connection'
      | 'posthog_invalid_credential'
      | 'posthog_invalid_response',
    message: string,
  ) {
    super(message);
    this.name = 'PostHogAnnotationError';
  }
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function resolveConnection(
  dependencies: PostHogAnnotationDependencies,
  input: { readonly organizationId: string; readonly projectId: string },
): Promise<PostHogConnection> {
  try {
    return PostHogConnectionSchema.parse(await dependencies.connection.resolve(input));
  } catch {
    throw new PostHogAnnotationError(
      'posthog_invalid_connection',
      'PostHog project connection is invalid.',
    );
  }
}

async function resolveToken(
  dependencies: PostHogAnnotationDependencies,
  input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly credentialRef: string;
  },
): Promise<string> {
  try {
    return PostHogCredentialSchema.parse(
      await dependencies.vault.resolveCredential({
        ...input,
        reason: 'posthog_release_annotation',
      }),
    ).token;
  } catch {
    throw new PostHogAnnotationError(
      'posthog_invalid_credential',
      'PostHog credential resolution failed.',
    );
  }
}

export function createPostHogReleaseAnnotationService(
  dependencies: PostHogAnnotationDependencies,
): {
  annotate(input: PostHogReleaseAnnotationInput): Promise<PostHogReleaseAnnotationResult>;
} {
  const request = dependencies.fetch ?? globalThis.fetch;

  return {
    async annotate(inputValue) {
      const input = PostHogReleaseAnnotationInputSchema.parse(inputValue);
      const connection = await resolveConnection(dependencies, input);
      const token = await resolveToken(dependencies, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        credentialRef: connection.credentialRef,
      });
      const collectionUrl = `${withoutTrailingSlash(connection.apiBaseUrl)}/api/projects/${String(connection.projectId)}/annotations/`;
      const body = {
        content: `release ${input.releaseId}`,
        date_marker: input.deployedAt,
        scope: 'project',
        creation_type: 'GIT',
      } as const;
      const mutationInput = KeyedMutationInputSchema.parse({
        key: `${input.operationKey}:posthog`,
        fingerprint: fingerprint({ collectionUrl, body }),
      });

      const result = await dependencies.mutations.runOnce(mutationInput, async () => {
        const providerResponse = await request(collectionUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (providerResponse.status !== 201) {
          throw new PostHogAnnotationError(
            'posthog_api_error',
            `PostHog annotation request failed with status ${String(providerResponse.status)}.`,
          );
        }
        try {
          return PostHogAnnotationResponseSchema.parse(await providerResponse.json());
        } catch {
          throw new PostHogAnnotationError(
            'posthog_invalid_response',
            'PostHog annotation response is invalid.',
          );
        }
      });
      const annotation = PostHogAnnotationResponseSchema.parse(result);

      return PostHogReleaseAnnotationResultSchema.parse({
        annotationId: annotation.id,
        annotationLink: `${collectionUrl}${String(annotation.id)}/`,
      });
    },
  };
}
