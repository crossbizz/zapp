import { AgentEventSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance, TenantDeps } from '../app.js';
import { ApiError } from '../errors.js';

/** The route-specific audience prevents a token for another internal operation being reused here. */
export const EVENTS_INGEST_AUDIENCE = 'control-api:events.ingest' as const;
const EVENTS_INGEST_CALLERS = ['orchestrator-worker'] as const;
const MAX_BATCH_EVENTS = 100;
const MAX_PAYLOAD_BYTES = 65_536;

const EventParams = z.object({ runId: idSchema('run') }).strict();
const EventInputSchema = AgentEventSchema.omit({ id: true, sequence: true }).strict();
const EventBatchSchema = z.array(EventInputSchema).min(1).max(MAX_BATCH_EVENTS);
const EventResponseSchema = z.object({ events: z.array(AgentEventSchema) }).strict();

export interface InternalEventRoutesDeps {
  readonly tenantDb: TenantDeps['tenantDb'];
}

function runNotFound(): ApiError {
  return new ApiError('run_not_found', 404, 'That run does not exist.');
}

/** CP-13's sole production insertion path for `agent_events`. */
export function registerInternalEventRoutes(app: AppInstance, deps: InternalEventRoutesDeps): void {
  app.post(
    '/internal/runs/:runId/events',
    {
      // `onRequest` intentionally precedes the idempotency plugin's appended
      // preHandler, so its scope is a verified service identity rather than IP.
      onRequest: app.requireService({
        audience: EVENTS_INGEST_AUDIENCE,
        callers: EVENTS_INGEST_CALLERS,
        singleUse: false,
      }),
      schema: {
        params: EventParams,
        body: EventBatchSchema,
        response: { 201: EventResponseSchema },
      },
    },
    async (request, reply) => {
      if (request.idempotency === undefined) {
        throw new ApiError(
          'idempotency_key_required',
          400,
          'An Idempotency-Key header is required for event ingestion.',
        );
      }

      // The bytes check is outside the transaction and before the tenant handle
      // is asked to allocate anything. JSON.stringify is intentional: the API
      // cap is the serialized JSON value stored in payload_json.
      for (const event of request.body) {
        if (Buffer.byteLength(JSON.stringify(event.payload), 'utf8') > MAX_PAYLOAD_BYTES) {
          throw new ApiError(
            'payload_too_large',
            413,
            'Event payloads larger than 65,536 bytes must be stored as artifacts.',
          );
        }
      }

      const first = request.body[0];
      if (
        first === undefined ||
        !request.body.every(
          (event) =>
            event.organizationId === first.organizationId &&
            event.projectId === first.projectId &&
            event.runId === request.params.runId,
        )
      ) {
        throw runNotFound();
      }

      const result = await deps.tenantDb(first.organizationId).events.ingest({
        runId: request.params.runId,
        projectId: first.projectId,
        events: request.body,
        audit: (tx, events) => {
          const sequences = events.map((event) => event.sequence);
          return request.auditService(tx, {
            organizationId: first.organizationId,
            action: 'run.events_ingested',
            target: { type: 'run', id: request.params.runId },
            metadata: {
              count: events.length,
              firstSequence: sequences[0] ?? null,
              lastSequence: sequences.at(-1) ?? null,
            },
          });
        },
      });
      if (result.kind === 'run_not_found') throw runNotFound();
      if (result.kind === 'payload_too_large') {
        throw new ApiError(
          'payload_too_large',
          413,
          'Event payloads larger than 65,536 bytes must be stored as artifacts.',
        );
      }
      const { events: stored } = result;

      return await reply.status(201).send({
        events: stored.map((event) =>
          AgentEventSchema.parse({
            id: event.id,
            runId: event.runId,
            sequence: event.sequence,
            occurredAt: event.occurredAt.toISOString(),
            organizationId: event.organizationId,
            projectId: event.projectId,
            ...(event.phaseId === null ? {} : { phaseId: event.phaseId }),
            ...(event.taskId === null ? {} : { taskId: event.taskId }),
            ...(event.agentId === null ? {} : { agentId: event.agentId }),
            type: event.type,
            visibility: event.visibility,
            payload: event.payloadJson,
          }),
        ),
      });
    },
  );
}
