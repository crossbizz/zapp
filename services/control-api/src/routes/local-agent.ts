import { z } from 'zod';
import {
  CompleteRequestSchema,
  GatewayStreamEventSchema,
  LocalAgentCompletionRequestSchema,
} from '@zapp/model-gateway';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { acceptsEventStream } from '../events/sse.js';
import {
  LocalAgentSessionSchema,
  type LocalAgentCompletionGateway,
  type LocalAgentSessionRepository,
} from '../local-agent/port.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';

const CreateLocalAgentSessionBody = z
  .object({
    sessionId: z.string().uuid(),
    localProjectName: z.string().trim().min(1).max(80),
  })
  .strict();

const LocalAgentSessionResponse = z
  .object({ session: LocalAgentSessionSchema })
  .strict();

export interface LocalAgentRoutesDeps {
  readonly sessions: LocalAgentSessionRepository;
  readonly gateway: LocalAgentCompletionGateway;
  readonly now: () => Date;
}

const LocalAgentSessionParams = z
  .object({ sessionId: z.string().uuid() })
  .strict();

async function writeEvent(
  response: NodeJS.WritableStream,
  event: z.infer<typeof GatewayStreamEventSchema>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    response.write(`data: ${JSON.stringify(event)}\n\n`, (error?: Error | null) => {
      if (error === undefined || error === null) resolve();
      else reject(error);
    });
  });
}

export function registerLocalAgentRoutes(app: AppInstance, deps: LocalAgentRoutesDeps): void {
  app.post(
    '/v1/local-agent/sessions',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        body: CreateLocalAgentSessionBody,
        response: { 201: LocalAgentSessionResponse },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      authorize(tenant, 'start_run');
      const session = LocalAgentSessionSchema.parse(
        await deps.sessions.ensure({
          sessionId: request.body.sessionId,
          organizationId: tenant.organizationId,
          userId: actorOf(request),
          localProjectName: request.body.localProjectName,
          now: deps.now(),
          audit: async (tx, created) => {
            await request.audit(tx, {
              organizationId: tenant.organizationId,
              action: 'run.created',
              target: { type: 'run', id: created.runId },
              metadata: { mode: 'local', sessionId: created.sessionId },
            });
          },
        }),
      );
      return await reply.status(201).send({ session });
    },
  );

  app.post(
    '/v1/local-agent/sessions/:sessionId/completions',
    {
      // The completion journal, keyed by completionId, owns replay. Buffering a
      // streamed response in the generic idempotency plugin would break SSE.
      config: { idempotency: 'exempt' },
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: LocalAgentSessionParams,
        body: LocalAgentCompletionRequestSchema,
        response: { 200: GatewayStreamEventSchema },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      authorize(tenant, 'start_run');
      if (!acceptsEventStream(request.headers.accept)) {
        throw new ApiError('event_stream_required', 406, 'Accept must permit text/event-stream.');
      }
      const userId = actorOf(request);
      const session = await deps.sessions.get({
        organizationId: tenant.organizationId,
        userId,
        sessionId: request.params.sessionId,
      });
      if (session === undefined) {
        throw new ApiError('local_agent_session_not_found', 404, 'That local session does not exist.');
      }
      const completion = CompleteRequestSchema.parse({
        ...request.body,
        organizationId: session.organizationId,
        projectId: session.projectId,
        runId: session.runId,
        taskId: session.taskId,
      });

      const abort = new AbortController();
      reply.raw.once('close', () => {
        abort.abort();
      });
      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('cache-control', 'no-cache, no-transform');
      reply.raw.setHeader('connection', 'keep-alive');
      reply.raw.setHeader('x-accel-buffering', 'no');
      if ('flushHeaders' in reply.raw) reply.raw.flushHeaders();

      try {
        for await (const eventValue of deps.gateway.stream(completion, abort.signal)) {
          if (abort.signal.aborted || reply.raw.destroyed) return;
          await writeEvent(reply.raw, GatewayStreamEventSchema.parse(eventValue));
        }
        if (!abort.signal.aborted && !reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.end();
        }
      } catch {
        abort.abort();
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          await writeEvent(reply.raw, {
            type: 'error',
            code: 'provider_error',
            message: 'The model completion failed.',
          });
          reply.raw.end();
        }
      }
    },
  );
}
