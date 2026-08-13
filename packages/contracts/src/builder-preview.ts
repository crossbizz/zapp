import { z } from 'zod';

/** Cursor page exposed to authenticated builder clients; bounded at the API edge. */
export const BuilderPreviewLogsQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().positive().max(1_000).default(100),
  })
  .strict();

export const BuilderPreviewLogEntrySchema = z
  .object({
    cursor: z.number().int().positive(),
    at: z.string().datetime(),
    stream: z.enum(['stdout', 'stderr']),
    message: z.string(),
  })
  .strict();

export const BuilderPreviewLogsResponseSchema = z
  .object({
    entries: z.array(BuilderPreviewLogEntrySchema),
    nextCursor: z.number().int().nonnegative(),
    truncated: z.boolean(),
    state: z.enum(['idle', 'starting', 'ready', 'restarting', 'failed']),
    failureId: z.string().min(1).nullable(),
  })
  .strict();

export const BuilderPreviewDevServerResponseSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    pid: z.number().int().positive(),
    supervisorId: z.string().min(1),
    ownership: z.enum(['process', 'process_group']),
  })
  .strict();

const BuilderPreviewCapturedTextSchema = z.string().max(4_096);
const BuilderPreviewCapturedUrlSchema = z.string().url().max(2_048);

export const BuilderPreviewEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('console'),
      payload: z
        .object({
          level: z.enum(['log', 'warn', 'error']),
          message: BuilderPreviewCapturedTextSchema,
          stack: BuilderPreviewCapturedTextSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('network'),
      payload: z
        .object({
          durationMs: z.number().finite().nonnegative(),
          method: z.string().min(1).max(32).regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u),
          status: z.number().int().min(0).max(599),
          transport: z.enum(['fetch', 'xhr']),
          url: BuilderPreviewCapturedUrlSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('route_change'),
      payload: z.object({ url: BuilderPreviewCapturedUrlSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('runtime_error'),
      payload: z
        .object({
          message: BuilderPreviewCapturedTextSchema,
          stack: BuilderPreviewCapturedTextSchema,
        })
        .strict(),
    })
    .strict(),
]);

export type BuilderPreviewLogsQuery = z.infer<typeof BuilderPreviewLogsQuerySchema>;
export type BuilderPreviewLogsResponse = z.infer<typeof BuilderPreviewLogsResponseSchema>;
export type BuilderPreviewDevServerResponse = z.infer<
  typeof BuilderPreviewDevServerResponseSchema
>;
export type BuilderPreviewEvent = z.infer<typeof BuilderPreviewEventSchema>;
