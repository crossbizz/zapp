import { z } from 'zod';

import {
  BranchForkInputSchema,
  CheckpointForkInputSchema,
  ConversationForkInputSchema,
  ForkActivityInputSchema,
  ForkActivityResultSchema,
  ForkInvariantError,
  ForkSourceNotFoundError,
  ProjectForkInputSchema,
  ReleaseRepairForkInputSchema,
  type ForkActivity,
} from '../activities/fork.js';
import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import type { OrganizationStore } from '../orgs/store.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { operationOf } from './runs.js';

const InternalActivityFields = {
  destinationOrganizationId: true,
  actorId: true,
  operationKey: true,
} as const;
const ForkBodySchema = z.discriminatedUnion('target', [
  ProjectForkInputSchema.omit(InternalActivityFields),
  BranchForkInputSchema.omit(InternalActivityFields),
  ConversationForkInputSchema.omit(InternalActivityFields),
  CheckpointForkInputSchema.omit(InternalActivityFields),
  ReleaseRepairForkInputSchema.omit(InternalActivityFields),
]);

export interface ForkRoutesDependencies {
  readonly activity: ForkActivity;
  readonly organizations: OrganizationStore;
}

export function registerForkRoutes(
  app: AppInstance,
  dependencies: ForkRoutesDependencies,
): void {
  app.post(
    '/v1/forks',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        body: ForkBodySchema,
        response: { 201: z.object({ fork: ForkActivityResultSchema }).strict() },
      },
    },
    async (request, reply) => {
      const context = tenantOf(request);
      const action =
        request.body.target === 'project'
          ? 'create_project'
          : request.body.target === 'conversation' || request.body.target === 'run_checkpoint'
            ? 'start_run'
            : 'edit_code';
      authorize(context, action);

      if (request.body.sourceOrganizationId !== context.organizationId) {
        const membership = await dependencies.organizations.membership(
          request.body.sourceOrganizationId,
          actorOf(request),
        );
        if (membership?.status !== 'active') throw sourceNotFound();
      }

      try {
        const result = await dependencies.activity.execute(
          ForkActivityInputSchema.parse({
            ...request.body,
            destinationOrganizationId: context.organizationId,
            actorId: actorOf(request),
            operationKey: operationOf(request),
          }),
        );
        return await reply.status(201).send({ fork: result });
      } catch (error) {
        if (error instanceof ForkSourceNotFoundError) throw sourceNotFound();
        if (error instanceof ForkInvariantError) {
          request.log.error({ errorKind: 'fork_invariant' }, 'fork activity broke its contract');
          throw new ApiError('fork_failed', 502, 'The fork could not be completed.');
        }
        request.log.warn({ errorKind: 'fork_unavailable' }, 'fork activity unavailable');
        throw new ApiError('fork_unavailable', 503, 'Forking is temporarily unavailable.');
      }
    },
  );
}

function sourceNotFound(): ApiError {
  return new ApiError('fork_source_not_found', 404, 'That fork source does not exist.');
}

export type { ForkActivity } from '../activities/fork.js';
