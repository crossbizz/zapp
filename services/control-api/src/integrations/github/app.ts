import { Octokit } from '@octokit/rest';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';

import {
  GitHubImportProviderError,
  GitHubPrepareImportInputSchema,
  GitHubPreparedImportSchema,
  GitHubProviderError,
  type GitHubImportProviderPort,
  type GitHubProviderPort,
} from './ports.js';
import {
  GitHubBranchSchema,
  GitHubBranchPageSchema,
  GitHubCompleteInstallationInputSchema,
  GitHubInstallationSchema,
  GitHubProviderConfigSchema,
  GitHubRepositorySchema,
  GitHubRepositoryPageSchema,
  type GitHubProviderConfig,
} from './schemas.js';
import type { GitHubSyncProviderPort } from './sync.js';
import type { GitHubExportProviderPort } from './export.js';

const InstallationTokenSchema = z.object({ token: z.string().min(1) }).strict();
const UserTokenExchangeResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.literal('bearer'),
    scope: z.literal(''),
    expires_in: z.number().int().positive().optional(),
    refresh_token: z.string().min(1).optional(),
    refresh_token_expires_in: z.number().int().positive().optional(),
  })
  .strict();
const UserInstallationsResponseSchema = z
  .object({
    totalCount: z.number().int().nonnegative(),
    installations: z.array(z.object({ id: z.number().int().positive() }).strict()),
  })
  .strict();
const RepositoryApiSchema = z
  .object({
    id: z.number().int().positive(),
    full_name: z.string().min(1),
    private: z.boolean(),
    default_branch: z.string().min(1),
  })
  .strict();
const ImportRepositoryApiSchema = z
  .object({ clone_url: z.string().url() })
  .strict();
const BranchApiSchema = z
  .object({ name: z.string().min(1), commit: z.object({ sha: GitHubBranchSchema.shape.headCommitSha }).strict() })
  .strict();

const CursorSchema = z.object({ page: z.number().int().positive() }).strict();

function pageOf(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  try {
    return CursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).page;
  } catch {
    throw new GitHubProviderError('not_found');
  }
}

function cursorFor(page: number): string {
  return Buffer.from(JSON.stringify({ page }), 'utf8').toString('base64url');
}

function hasNext(link: string | undefined): boolean {
  return link?.split(',').some((part) => /rel="next"/u.test(part)) === true;
}

function providerFailure(error: unknown): GitHubProviderError {
  if (error instanceof GitHubProviderError) return error;
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined;
  return new GitHubProviderError(status === 404 ? 'not_found' : 'unavailable');
}

function errorStatus(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status?: unknown }).status
    : undefined;
}

function oauthEndpoint(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return 'https://github.com/login/oauth/access_token';
  const url = new URL(baseUrl);
  if (url.hostname === 'api.github.com') url.hostname = 'github.com';
  url.pathname = '/login/oauth/access_token';
  url.search = '';
  url.hash = '';
  return url.href;
}

export function createGitHubProvider(
  rawConfig: GitHubProviderConfig,
): GitHubProviderPort & GitHubImportProviderPort & GitHubSyncProviderPort & GitHubExportProviderPort {
  const config = GitHubProviderConfigSchema.parse(rawConfig);
  const base = config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl.replace(/\/+$/u, '') };

  async function appJwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    const key = await importPKCS8(config.privateKey, 'RS256');
    return await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 9 * 60)
      .setIssuer(config.appId)
      .sign(key);
  }

  async function appClient(): Promise<Octokit> {
    return new Octokit({ ...base, auth: await appJwt() });
  }

  async function installationAccess(
    installationId: string,
  ): Promise<{ readonly client: Octokit; readonly token: string }> {
    const app = await appClient();
    const response = await app.rest.apps.createInstallationAccessToken({
      installation_id: Number(installationId),
    });
    const parsed = InstallationTokenSchema.parse({ token: response.data.token });
    return { client: new Octokit({ ...base, auth: parsed.token }), token: parsed.token };
  }

  async function installationClient(installationId: string): Promise<Octokit> {
    return (await installationAccess(installationId)).client;
  }

  async function exchangeUserToken(code: string): Promise<string> {
    const response = await fetch(oauthEndpoint(config.baseUrl), {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
      }),
    });
    if (!response.ok) throw new GitHubProviderError('unavailable');
    const parsed = UserTokenExchangeResponseSchema.parse(await response.json());
    return parsed.access_token;
  }

  return {
    async prepareRepository(input) {
      const [owner, repo] = z.tuple([z.string().min(1), z.string().min(1)]).parse(input.externalRepoRef.split('/'));
      const access = await installationAccess(input.installationId);
      const response = await access.client.rest.repos.get({ owner, repo });
      return { cloneUrl: z.string().url().parse(response.data.clone_url), token: access.token };
    },
    async openPullRequest(input) {
      const [owner, repo] = z.tuple([z.string().min(1), z.string().min(1)]).parse(input.externalRepoRef.split('/'));
      const client = await installationClient(input.installationId);
      const response = await client.rest.pulls.create({ owner, repo, head: input.head, base: input.base, title: input.title });
      return { number: response.data.number, url: z.string().url().parse(response.data.html_url) };
    },
    async createRepository(input) {
      const app = await appClient();
      const installation = await app.rest.apps.getInstallation({ installation_id: Number(input.installationId) });
      const account = z.object({ login: z.string().min(1), type: z.string().min(1) }).parse(installation.data.account);
      const access = await installationAccess(input.installationId);
      let repository;
      try {
        repository = await access.client.rest.repos.get({ owner: account.login, repo: input.name });
      } catch (error) {
        if (errorStatus(error) !== 404) throw error;
        repository = account.type === 'Organization'
          ? await access.client.rest.repos.createInOrg({ org: account.login, name: input.name, private: input.private })
          : await access.client.rest.repos.createForAuthenticatedUser({ name: input.name, private: input.private });
      }
      return {
        fullName: z.string().min(1).parse(repository.data.full_name),
        repositoryUrl: z.string().url().parse(repository.data.html_url),
        cloneUrl: z.string().url().parse(repository.data.clone_url),
        token: access.token,
      };
    },
    repositoryUrl(externalRepoRef) {
      return new URL(externalRepoRef, 'https://github.com/').toString();
    },
    async completeInstallation(rawInput) {
      try {
        const input = GitHubCompleteInstallationInputSchema.parse(rawInput);
        const userToken = await exchangeUserToken(input.code);
        const client = new Octokit({ ...base, auth: userToken });
        let page = 1;
        for (;;) {
          const response = await client.rest.apps.listInstallationsForAuthenticatedUser({
            per_page: 100,
            page,
          });
          const installations = UserInstallationsResponseSchema.parse({
            totalCount: response.data.total_count,
            installations: response.data.installations.map((installation) => ({
              id: installation.id,
            })),
          });
          const match = installations.installations.find(
            (installation) => String(installation.id) === input.installationId,
          );
          if (match !== undefined) {
            return GitHubInstallationSchema.parse({ installationId: String(match.id) });
          }
          if (!hasNext(response.headers.link)) throw new GitHubProviderError('not_found');
          page += 1;
        }
      } catch (error) {
        throw providerFailure(error);
      }
    },
    async listRepositories(input) {
      try {
        const page = pageOf(input.cursor);
        const client = await installationClient(input.installationId);
        const response = await client.rest.apps.listReposAccessibleToInstallation({
          page,
          per_page: 100,
        });
        const items = response.data.repositories.map((repository) => {
          const parsed = RepositoryApiSchema.parse({
            id: repository.id,
            full_name: repository.full_name,
            private: repository.private,
            default_branch: repository.default_branch,
          });
          return GitHubRepositorySchema.parse({
            id: String(parsed.id),
            fullName: parsed.full_name,
            private: parsed.private,
            defaultBranch: parsed.default_branch,
          });
        });
        return GitHubRepositoryPageSchema.parse({
          items,
          nextCursor: hasNext(response.headers.link) ? cursorFor(page + 1) : null,
        });
      } catch (error) {
        throw providerFailure(error);
      }
    },
    async listBranches(input) {
      try {
        const page = pageOf(input.cursor);
        const client = await installationClient(input.installationId);
        const response = await client.request('GET /repositories/{repository_id}/branches', {
          repository_id: Number(input.repositoryId),
          page,
          per_page: 100,
        });
        const rows = z.array(z.unknown()).parse(response.data);
        const items = rows.map((row) => {
          const value = row as { name?: unknown; commit?: { sha?: unknown } };
          const parsed = BranchApiSchema.parse({
            name: value.name,
            commit: { sha: value.commit?.sha },
          });
          return GitHubBranchSchema.parse({ name: parsed.name, headCommitSha: parsed.commit.sha });
        });
        return GitHubBranchPageSchema.parse({
          items,
          nextCursor: hasNext(response.headers.link) ? cursorFor(page + 1) : null,
        });
      } catch (error) {
        throw providerFailure(error);
      }
    },
    async prepareImport(rawInput) {
      const input = GitHubPrepareImportInputSchema.parse(rawInput);
      const [owner, repo] = z.tuple([z.string().min(1), z.string().min(1)]).parse(input.repo.split('/'));
      try {
        const access = await installationAccess(input.installationId);
        let repositoryResponse;
        try {
          repositoryResponse = await access.client.rest.repos.get({ owner, repo });
        } catch (error) {
          throw new GitHubImportProviderError(
            errorStatus(error) === 404 ? 'repository_not_found' : 'github_unavailable',
          );
        }
        try {
          await access.client.rest.repos.getBranch({
            owner,
            repo,
            branch: input.branch,
          });
        } catch (error) {
          throw new GitHubImportProviderError(
            errorStatus(error) === 404 ? 'branch_not_found' : 'github_unavailable',
          );
        }
        const repository = ImportRepositoryApiSchema.parse({
          clone_url: repositoryResponse.data.clone_url,
        });
        return GitHubPreparedImportSchema.parse({
          sourceCloneUrl: repository.clone_url,
          sourceToken: access.token,
        });
      } catch (error) {
        if (error instanceof GitHubImportProviderError) throw error;
        throw new GitHubImportProviderError('github_unavailable');
      }
    },
  };
}
