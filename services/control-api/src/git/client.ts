import { defineEnv, createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import { z } from 'zod';

import {
  GIT_CREATE_DEADLINE_MS,
  GIT_IMPORT_DEADLINE_MS,
  GitServiceError,
  GitServiceImportConflictError,
  GitRepositoryImportInputSchema,
  GitRepositoryImportResultSchema,
  createRecordOnlyGitService,
  type CreateRepositoryInput,
  type CreatedRepository,
  type GitImportServicePort,
} from './port.js';

/**
 * The real {@link GitServicePort}: an HTTP call to `services/git-service` (plan
 * 06 GIT-2).
 *
 * This is the line CP-6 said would be swapped — the record-only stand-in named a
 * repository and contacted nothing, and everything downstream was written so
 * that replacing it changed one binding in `src/compose.ts` and nothing else.
 * What it adds is the part the stand-in could not: the repository exists
 * afterwards, and `repositories.provisioned_at` says so.
 *
 * Four things are load-bearing here.
 *
 * **1. The deadline is enforced by us, not hoped for.** This runs inside the
 * transaction that creates the project, holding a pooled PostgreSQL connection
 * open for its whole duration — see {@link GIT_CREATE_DEADLINE_MS}, which
 * explains why an unbounded wait here is a service-wide outage rather than a slow
 * create. `AbortSignal.timeout` is what makes the constant a fact.
 *
 * **2. A token is minted per call.** Service tokens live minutes (CP-8), and
 * minting one is an HMAC and no network, so there is nothing to cache and no
 * cache to invalidate when the secret rotates.
 *
 * **3. Nothing the git service says reaches the client.** Its error bodies are
 * already scrubbed, but this side re-states the rule anyway: every failure
 * becomes a {@link GitServiceError} whose message names the operation, and the
 * route above turns that into a 502 with none of it in the body.
 *
 * **4. The ref comes back from the git service and is not re-derived here.**
 * Both sides compute it with `internalRepoRef` from `@zapp/contracts`, so they
 * agree by construction — but the value written to `repositories` is the one the
 * service actually created a repository at, not the one this process expected it
 * to.
 */

/**
 * Where the git service lives, e.g. `http://zapp-git-service.internal:4500`.
 *
 * Optional in the schema and *not* optional in a deployment — see
 * {@link resolveGitService}. It has no default because there is no address that
 * is right by accident: a wrong one is a control plane that creates projects
 * whose repositories are somewhere else.
 */
const GitServiceEnvSchema = z.object({
  GIT_SERVICE_URL: z
    .union([
      z
        .string()
        .url()
        // `.url()` alone accepts anything `new URL()` parses, which includes
        // `git-service:4500` (scheme `git-service:`) and `file:///…`. The scheme
        // decides what `fetch` does with the value, so it is pinned rather than
        // assumed: over the private network this is http, and over anything else
        // it is https.
        .refine(
          (value) => /^https?:\/\//.test(value),
          'GIT_SERVICE_URL must be an http or https URL',
        ),
      z.literal(''),
    ])
    .optional(),
});

/** @throws Error naming the offending variable — never its value. */
export function loadGitServiceUrl(source: unknown = process.env): string | undefined {
  const url = defineEnv(GitServiceEnvSchema, source).GIT_SERVICE_URL;
  // Empty and absent mean the same thing: `.env.example` ships the key so that
  // pointing a deployment at a git service is a value change rather than a
  // schema change, exactly as `SERVICE_TOKEN_SECRET_PREVIOUS` is.
  return url === undefined || url === '' ? undefined : url.replace(/\/+$/, '');
}

interface CreatedRepositoryResponse {
  readonly internalRepoRef?: string;
  readonly cloneUrl?: string;
  readonly provisionedAt?: string;
}

export interface GitServiceClientOptions {
  readonly baseUrl: string;
  /** The shared secret this process signs its outbound service tokens with (CP-8). */
  readonly serviceTokens: ServiceTokenConfig;
  /** Injected in tests. Node 22's global `fetch` is the shipping one. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export function createGitServiceClient(options: GitServiceClientOptions): GitImportServicePort {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  return {
    async createRepository(input: CreateRepositoryInput): Promise<CreatedRepository> {
      const { token } = await signer.signServiceToken({
        service: 'control-api',
        // The git service's own audience. A token minted here is not spendable
        // on the control plane's internal decrypt route, and vice versa.
        aud: 'git-service',
      });

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/internal/git/repositories`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'x-zapp-service-token': token,
          },
          body: JSON.stringify({
            organizationId: input.organizationId,
            projectId: input.projectId,
            defaultBranch: input.defaultBranch,
            // The slug is a *description*, never part of the ref: it is mutable,
            // and a ref derived from it desynchronizes on the first rename
            // (see `port.ts`). It travels so the Git host's own UI is readable
            // by a human, and for nothing else.
            description: input.projectSlug.slice(0, 255),
          }),
          // See GIT_CREATE_DEADLINE_MS: this call is made with a database
          // transaction open, so "wait until TCP gives up" is not an option.
          signal: AbortSignal.timeout(GIT_CREATE_DEADLINE_MS),
        });
      } catch (error) {
        // A timeout, a refused connection, DNS. The message names the operation
        // and never the URL: a fetch error quotes it, and a URL is a place a
        // credential can hide.
        throw new GitServiceError('the git service could not be reached', { cause: error });
      }

      if (response.status !== 201) {
        throw new GitServiceError(
          `the git service refused to create the repository (${String(response.status)})`,
        );
      }

      let body: CreatedRepositoryResponse;
      try {
        body = (await response.json()) as CreatedRepositoryResponse;
      } catch (error) {
        throw new GitServiceError('the git service returned an unreadable response', {
          cause: error,
        });
      }

      const internalRepoRef = body.internalRepoRef;
      if (internalRepoRef === undefined || internalRepoRef === '') {
        // A 201 with no ref is a response we cannot write a row from, and
        // guessing one would put a `repositories` row at an address nothing
        // created.
        throw new GitServiceError('the git service returned no repository ref');
      }

      const provisionedAt =
        body.provisionedAt === undefined ? undefined : new Date(body.provisionedAt);
      return {
        internalRepoRef,
        // Only when it parses. `provisioned_at` is what distinguishes a row that
        // names a repository from a repository that exists, and an Invalid Date
        // written into that column would say "provisioned" while meaning
        // nothing.
        ...(provisionedAt === undefined || Number.isNaN(provisionedAt.getTime())
          ? {}
          : { provisionedAt }),
      };
    },
    async importRepository(rawInput) {
      const input = GitRepositoryImportInputSchema.parse(rawInput);
      const { token } = await signer.signServiceToken({
        service: 'control-api',
        aud: 'git-service',
      });
      let response: Response;
      try {
        response = await doFetch(
          `${baseUrl}/internal/git/repositories/${input.organizationId}/${input.projectId}/import`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              'x-zapp-service-token': token,
            },
            body: JSON.stringify({
              externalRepoRef: input.externalRepoRef,
              sourceCloneUrl: input.sourceCloneUrl,
              sourceToken: input.sourceToken,
              sourceBranch: input.sourceBranch,
            }),
            signal: AbortSignal.timeout(GIT_IMPORT_DEADLINE_MS),
          },
        );
      } catch (error) {
        throw new GitServiceError('the git service could not be reached for repository import', {
          cause: error,
        });
      }
      if (response.status === 409) throw new GitServiceImportConflictError();
      if (response.status !== 200) {
        throw new GitServiceError(
          `the git service refused the repository import (${String(response.status)})`,
        );
      }
      try {
        return GitRepositoryImportResultSchema.parse(await response.json());
      } catch (error) {
        throw new GitServiceError('the git service returned invalid repository import metadata', {
          cause: error,
        });
      }
    },
  };
}

/**
 * Whether this process is one a mistake is allowed to be cheap in.
 *
 * A second copy of `src/app.ts`'s `isDevelopment`, deliberately: that one is
 * private to the module that owns the fallback guards, and exporting it to reach
 * it from here would widen an API whose whole purpose is to be narrow. The rule
 * is the same and stated there — an *unset* `NODE_ENV` counts as production,
 * because every switch that reads it is safer in its production position.
 */
function isDevelopment(): boolean {
  const environment = process.env['NODE_ENV'];
  return environment === 'development' || environment === 'test';
}

/**
 * The binding `composeApp` uses: the real client when the deployment named a git
 * service, and a refusal to start when it did not.
 *
 * The same shape as `buildApp`'s `inDevelopmentOnly` guards, for the same reason.
 * A control plane that fell back to the record-only stand-in in production would
 * create projects whose `repositories` rows point at repositories that do not
 * exist — every one of them a clone failure at the first run, days after the
 * deployment that caused it, with `provisioned_at` null and nothing saying why.
 * Locally the fallback is exactly right: it is what lets `pnpm dev` create
 * projects without a git service running.
 *
 * @throws Error when `GIT_SERVICE_URL` is unset outside development.
 */
export function resolveGitService(options: {
  readonly baseUrl: string | undefined;
  readonly serviceTokens: ServiceTokenConfig;
}): GitImportServicePort {
  if (options.baseUrl === undefined) {
    if (!isDevelopment()) {
      throw new Error(
        'refusing to start: no GIT_SERVICE_URL was supplied, and without one every project would be created with a repository that does not exist',
      );
    }
    return createRecordOnlyGitService();
  }
  return createGitServiceClient({
    baseUrl: options.baseUrl,
    serviceTokens: options.serviceTokens,
  });
}
