import {
  ConversationEventPageSchema,
  ConversationEventSchema,
  ConversationPageSchema,
  ConversationSummarySchema,
  idSchema,
} from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { DEFAULT_PAGE_SIZE } from '../pagination.js';
import { authorize, tenantOf } from '../plugins/tenant.js';

interface ConversationListCursor {
  readonly updatedAt: Date;
  readonly id: string;
}

interface ConversationEventCursor {
  readonly runNumber: number;
  readonly sequence: number;
}

const ProjectParams = z.object({ projectId: idSchema('proj') }).strict();
const ConversationParams = z.object({ conversationId: idSchema('conv') }).strict();
const PageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
const ConversationListCursorSchema = z
  .object({ updatedAt: z.string().datetime(), id: idSchema('conv') })
  .strict();
const ConversationEventCursorSchema = z
  .object({ runNumber: z.number().int().positive(), sequence: z.number().int().nonnegative() })
  .strict();

export function registerConversationRoutes(app: AppInstance): void {
  app.get(
    '/v1/projects/:projectId/conversations',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: ProjectParams,
        querystring: PageQuery,
        response: { 200: ConversationPageSchema },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) throw projectNotFound();
      authorize(ctx, 'view_project');
      const cursor =
        request.query.cursor === undefined
          ? undefined
          : decodeListCursor(request.query.cursor);
      const page = await ctx.db.conversations.listByProject(project.id, {
        limit: request.query.limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      return ConversationPageSchema.parse({
        items: page.items.map(({ conversation, latestRun, runCount }) =>
          ConversationSummarySchema.parse({
            id: conversation.id,
            projectId: conversation.projectId,
            title: conversation.title,
            createdAt: conversation.createdAt.toISOString(),
            updatedAt: conversation.updatedAt.toISOString(),
            latestRun: { id: latestRun.id, status: latestRun.status },
            runCount,
          }),
        ),
        nextCursor: page.nextCursor === null ? null : encodeCursor({
          updatedAt: page.nextCursor.updatedAt.toISOString(),
          id: page.nextCursor.id,
        }),
      });
    },
  );

  app.get(
    '/v1/conversations/:conversationId/events',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: ConversationParams,
        querystring: PageQuery,
        response: { 200: ConversationEventPageSchema },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const conversation = await ctx.db.conversations.getById(request.params.conversationId);
      if (conversation === undefined) throw conversationNotFound();
      authorize(ctx, 'view_project');
      const cursor =
        request.query.cursor === undefined
          ? undefined
          : decodeEventCursor(request.query.cursor);
      const page = await ctx.db.conversations.listEvents(conversation.id, {
        limit: request.query.limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      return ConversationEventPageSchema.parse({
        items: page.items.map(({ runNumber, event }) =>
          ConversationEventSchema.parse({
            runNumber,
            event: {
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
              payload: event.payloadJson as Record<string, unknown>,
            },
          }),
        ),
        nextCursor:
          page.nextCursor === null ? null : encodeCursor(page.nextCursor),
      });
    },
  );
}

function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeListCursor(value: string): ConversationListCursor {
  const decoded = decodeCursor(value, ConversationListCursorSchema);
  return { updatedAt: new Date(decoded.updatedAt), id: decoded.id };
}

function decodeEventCursor(value: string): ConversationEventCursor {
  return decodeCursor(value, ConversationEventCursorSchema);
}

function decodeCursor<Output>(value: string, schema: z.ZodType<Output>): Output {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return schema.parse(parsed);
  } catch {
    throw new ApiError('invalid_cursor', 400, 'The pagination cursor is invalid.');
  }
}

function projectNotFound(): ApiError {
  return new ApiError('project_not_found', 404, 'That project does not exist.');
}

function conversationNotFound(): ApiError {
  return new ApiError('conversation_not_found', 404, 'That conversation does not exist.');
}
