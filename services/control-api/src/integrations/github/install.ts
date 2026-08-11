import type { AppInstance } from '../../app.js';
import { ApiError } from '../../errors.js';
import { actorOf } from '../../plugins/auth.js';
import { authorize, tenantOf } from '../../plugins/tenant.js';
import type { IntegrationPort } from '../../routes/integrations.js';
import type { TenantDbFactory } from '../../tenant/db.js';
import { GitHubProviderError, type GitHubProviderPort } from './ports.js';
import {
  GitHubAuthorizeResponseSchema,
  GitHubBranchPageSchema,
  GitHubDiscoveryQuerySchema,
  GitHubRepositoryPageSchema,
  GitHubRepositoryParamsSchema,
} from './schemas.js';
import {
  GITHUB_AUTHORIZATION_STATE_TTL_MS,
  type GitHubAuthorizationStateStore,
} from './store.js';

export interface GitHubInstallDependencies {
  readonly appSlug: string;
  readonly provider: GitHubProviderPort;
  readonly stateStore: GitHubAuthorizationStateStore;
}

export function createGitHubIntegrationPort(input: {
  readonly tenantDb: TenantDbFactory;
  readonly provider: GitHubProviderPort;
  readonly stateStore: GitHubAuthorizationStateStore;
}): IntegrationPort {
  return {
    async connect(request) {
      if (request.provider !== 'github') {
        throw new Error('integration service unavailable');
      }
      const consumed = await input.stateStore.consume(request.state, {
        organizationId: request.organizationId,
        actorId: request.actorId,
      });
      if (!consumed) throw new Error('GitHub authorization state rejected');
      const verified = await input.provider.completeInstallation({
        installationId: request.configuration.installationId,
        code: request.credential,
      });
      return await input.tenantDb(request.organizationId).integrations.connectGitHub({
        installationId: verified.installationId,
        audit: request.audit,
      });
    },
  };
}

export function registerGitHubInstallRoutes(
  app: AppInstance,
  dependencies: GitHubInstallDependencies,
): void {
  app.post(
    '/v1/integrations/github/install/authorize',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: { response: { 200: GitHubAuthorizeResponseSchema } },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      authorize(tenant, 'manage_organization');
      const state = await dependencies.stateStore.issue(
        { organizationId: tenant.organizationId, actorId: actorOf(request) },
        GITHUB_AUTHORIZATION_STATE_TTL_MS,
      );
      const url = new URL(
        `https://github.com/apps/${encodeURIComponent(dependencies.appSlug)}/installations/new`,
      );
      url.searchParams.set('state', state);
      return await reply.status(200).send(GitHubAuthorizeResponseSchema.parse({ url: url.href }));
    },
  );

  app.get(
    '/v1/integrations/github/repositories',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        querystring: GitHubDiscoveryQuerySchema,
        response: { 200: GitHubRepositoryPageSchema },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      authorize(tenant, 'view_project');
      const query = GitHubDiscoveryQuerySchema.parse(request.query);
      await requireInstallation(tenant.db, query.installationId);
      try {
        const page = GitHubRepositoryPageSchema.parse(
          await dependencies.provider.listRepositories({
            installationId: query.installationId,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }),
        );
        return await reply.status(200).send(page);
      } catch (error) {
        throw discoveryError(error);
      }
    },
  );

  app.get(
    '/v1/integrations/github/repositories/:repositoryId/branches',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: GitHubRepositoryParamsSchema,
        querystring: GitHubDiscoveryQuerySchema,
        response: { 200: GitHubBranchPageSchema },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      authorize(tenant, 'view_project');
      const query = GitHubDiscoveryQuerySchema.parse(request.query);
      const params = GitHubRepositoryParamsSchema.parse(request.params);
      await requireInstallation(tenant.db, query.installationId);
      try {
        const page = GitHubBranchPageSchema.parse(
          await dependencies.provider.listBranches({
            installationId: query.installationId,
            repositoryId: params.repositoryId,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }),
        );
        return await reply.status(200).send(page);
      } catch (error) {
        throw discoveryError(error);
      }
    },
  );
}

async function requireInstallation(
  database: ReturnType<TenantDbFactory>,
  installationId: string,
): Promise<void> {
  if ((await database.integrations.getGitHubInstallation(installationId)) === undefined) {
    throw new ApiError('integration_not_found', 404, 'That integration does not exist.');
  }
}

function discoveryError(error: unknown): ApiError {
  if (error instanceof GitHubProviderError && error.failure === 'not_found') {
    return new ApiError('github_resource_not_found', 404, 'That GitHub resource does not exist.');
  }
  return new ApiError(
    'github_unavailable',
    502,
    'GitHub could not complete the request.',
  );
}
