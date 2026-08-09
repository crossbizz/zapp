import {
  CompletionIdSchema,
  CreditCeilingIncreaseRequestSchema,
  CreditCeilingIncreaseResponseSchema,
  ModelCompletionClaimRequestSchema,
  ModelCompletionClaimResponseSchema,
  ModelCompletionCommitRequestSchema,
  ModelCompletionCommitResponseSchema,
  ModelCompletionGetResponseSchema,
  idSchema,
} from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import {
  CompletionClaimLostError,
  CompletionConflictError,
  CompletionNotFoundError,
  CompletionUsageExceedsReservationError,
  CreditCeilingIncreaseRejectedError,
  type ModelCompletionRepository,
} from '../usage/model-completions.js';

export const MODEL_COMPLETIONS_AUDIENCE = 'control-api:model-completions' as const;
export const CREDIT_CEILINGS_AUDIENCE = 'control-api:credit-ceilings' as const;

const CompletionParamsSchema = z.object({ completionId: CompletionIdSchema }).strict();
const CompletionQuerySchema = z.object({ organizationId: idSchema('org') }).strict();
const RunParamsSchema = z.object({ runId: idSchema('run') }).strict();

export function registerInternalModelCompletionRoutes(
  app: AppInstance,
  repository: ModelCompletionRepository,
): void {
  app.post(
    '/internal/model-completions/claim',
    {
      onRequest: app.requireService({
        audience: MODEL_COMPLETIONS_AUDIENCE,
        callers: ['model-gateway'],
        singleUse: false,
      }),
      schema: {
        body: ModelCompletionClaimRequestSchema,
        response: { 200: ModelCompletionClaimResponseSchema },
      },
    },
    async (request) => await translateErrors(async () => await repository.claim(request.body)),
  );

  app.post(
    '/internal/model-completions/:completionId/commit',
    {
      onRequest: app.requireService({
        audience: MODEL_COMPLETIONS_AUDIENCE,
        callers: ['model-gateway'],
        singleUse: false,
      }),
      schema: {
        params: CompletionParamsSchema,
        body: ModelCompletionCommitRequestSchema,
        response: { 200: ModelCompletionCommitResponseSchema },
      },
    },
    async (request) => {
      if (request.params.completionId !== request.body.completionId) throw notFound();
      return await translateErrors(async () => await repository.commit(request.body));
    },
  );

  app.get(
    '/internal/model-completions/:completionId',
    {
      onRequest: app.requireService({
        audience: MODEL_COMPLETIONS_AUDIENCE,
        callers: ['model-gateway'],
        singleUse: false,
      }),
      schema: {
        params: CompletionParamsSchema,
        querystring: CompletionQuerySchema,
        response: { 200: ModelCompletionGetResponseSchema },
      },
    },
    async (request) => {
      const completion = await repository.get(
        request.query.organizationId,
        request.params.completionId,
      );
      if (completion === undefined) throw notFound();
      return { completion };
    },
  );

  app.post(
    '/internal/runs/:runId/credit-ceiling-increases',
    {
      onRequest: app.requireService({
        audience: CREDIT_CEILINGS_AUDIENCE,
        callers: ['orchestrator-worker'],
        singleUse: false,
      }),
      schema: {
        params: RunParamsSchema,
        body: CreditCeilingIncreaseRequestSchema,
        response: { 200: CreditCeilingIncreaseResponseSchema },
      },
    },
    async (request) => {
      if (request.params.runId !== request.body.runId) throw notFound();
      const credits = await translateErrors(
        async () => await repository.increaseCeiling(request.body),
      );
      return { credits };
    },
  );
}

async function translateErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CompletionNotFoundError) throw notFound();
    if (error instanceof CompletionConflictError) {
      throw new ApiError('completion_conflict', 409, 'That completion identity conflicts.');
    }
    if (error instanceof CompletionClaimLostError) {
      throw new ApiError('completion_claim_lost', 409, 'That completion claim is no longer held.');
    }
    if (error instanceof CompletionUsageExceedsReservationError) {
      throw new ApiError(
        'completion_usage_exceeds_reservation',
        409,
        'That completion usage exceeds its durable reservation.',
      );
    }
    if (error instanceof CreditCeilingIncreaseRejectedError) {
      throw new ApiError(
        'credit_ceiling_increase_rejected',
        409,
        'That approved credit ceiling increase cannot be applied.',
      );
    }
    throw error;
  }
}

function notFound(): ApiError {
  return new ApiError('completion_not_found', 404, 'That completion or run does not exist.');
}
