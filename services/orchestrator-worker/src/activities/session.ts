import { CompleteAsyncError, Context } from '@temporalio/activity';
import { ActivityCancelledError } from '@temporalio/client';
import { idSchema, MessageUserPayloadSchema, RunModeSchema, TOOL_NAMES } from '@zapp/contracts';
import { z } from 'zod';

import {
  createSessionLoop,
  SessionInputSchema,
  SessionResultSchema,
  type SessionInput,
  type SessionEvent,
  type SessionResult,
} from '../session/loop.js';
import { sessionEventToPendingAgentEvent, type PendingAgentEvent } from './events.js';
import {
  CheckpointTranscriptStore,
  MAX_TEMPORAL_TRANSCRIPT_BYTES,
  SessionTranscriptSchema,
  type TranscriptStore,
} from '../session/transcript.js';

export const SessionCheckpointSchema = z
  .object({
    runId: idSchema('run'),
    taskId: z.string().min(1),
    transcript: SessionTranscriptSchema.nullable().default(null),
  })
  .strict();
export type SessionCheckpoint = z.infer<typeof SessionCheckpointSchema>;

export const RunBuilderSessionInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    workspaceId: z.string().min(1).max(512),
    mode: RunModeSchema,
    model: z.string().min(1).max(160).nullable(),
    prompt: z.string().min(1).max(20_000),
    allowedTools: z.array(z.enum(TOOL_NAMES)).superRefine((tools, validation) => {
      if (new Set(tools).size !== tools.length) {
        validation.addIssue({ code: z.ZodIssueCode.custom, message: 'Allowed tools must be unique' });
      }
    }),
    modeInstructions: z.string().min(1).max(4_000),
    budget: z
      .object({ maxCredits: z.number().int().positive().max(1_000_000) })
      .strict()
      .nullable(),
    control: z
      .object({
        yieldAfterTool: z.boolean(),
        redirect: z
          .object({
            operationKey: z.string().regex(/^op_[a-f0-9]{64}$/u),
            instruction: z.string().trim().min(1).max(20_000),
          })
          .strict()
          .nullable(),
        message: MessageUserPayloadSchema.extend({
          operationKey: z.string().regex(/^op_[a-f0-9]{64}$/u),
        })
          .strict()
          .nullable()
          .optional(),
      })
      .strict()
      .optional(),
    idempotencyKey: z.string().min(1).max(512),
  })
  .strict();
export type RunBuilderSessionInput = z.infer<typeof RunBuilderSessionInputSchema>;

export interface BuilderSessionContext {
  readonly resumeCheckpoint: SessionCheckpoint | undefined;
  readonly transcripts: TranscriptStore;
  readonly signal: AbortSignal;
  readonly events: { emit(event: SessionEvent): Promise<void> };
}

export interface BuilderSessionRunner {
  run(
    input: RunBuilderSessionInput,
    context: BuilderSessionContext,
  ): Promise<SessionResult>;
}

export interface SessionActivities {
  runBuilderSession(input: RunBuilderSessionInput): Promise<SessionResult>;
}

export interface SessionActivityOptions {
  readonly heartbeatIntervalMs?: number;
  readonly publishSessionEvent?: (event: PendingAgentEvent) => Promise<void>;
}

/** Binds the coarse durable-run input to the exact AR-6 session-loop contract. */
export function adaptSessionLoop(
  createLoop: (
    transcripts: TranscriptStore,
    events: BuilderSessionContext['events'],
  ) => Pick<ReturnType<typeof createSessionLoop>, 'run'>,
  buildInput: (input: RunBuilderSessionInput) => SessionInput,
): BuilderSessionRunner {
  return {
    run(input, context) {
      const built = buildInput(input);
      return createLoop(context.transcripts, context.events).run(
        SessionInputSchema.parse({
          ...built,
          tools: input.allowedTools,
          modeInstructions: input.modeInstructions,
          ...(input.control === undefined
            ? {}
            : {
                control: {
                  yieldAfterTool: input.control.yieldAfterTool,
                  redirect: input.control.redirect,
                  message:
                    input.control.message === null || input.control.message === undefined
                      ? null
                      : {
                          operationKey: input.control.message.operationKey,
                          message: MessageUserPayloadSchema.parse({
                            messageId: input.control.message.messageId,
                            content: input.control.message.content,
                            attachments: input.control.message.attachments,
                            source: input.control.message.source,
                          }),
                        },
                },
              }),
        }),
        context.signal,
      );
    },
  };
}

/** Wraps the AR-6 runner in Temporal heartbeats so an activity retry receives its checkpoint. */
export function createSessionActivities(
  runner: BuilderSessionRunner,
  options: SessionActivityOptions = {},
): SessionActivities {
  const heartbeatIntervalMs = z
    .number()
    .int()
    .positive()
    .max(10_000)
    .parse(options.heartbeatIntervalMs ?? 1_000);
  return {
    async runBuilderSession(inputValue) {
      const input = RunBuilderSessionInputSchema.parse(inputValue);
      const activityContext = Context.current();
      let checkpoint =
        SessionCheckpointSchema.optional().parse(activityContext.info.heartbeatDetails) ??
        SessionCheckpointSchema.parse({ runId: input.runId, taskId: 'm1-builder', transcript: null });
      if (checkpoint.runId !== input.runId || checkpoint.taskId !== 'm1-builder') {
        throw new Error('Temporal session checkpoint does not match the activity input');
      }
      let checkpointHeartbeatTail = Promise.resolve();
      let checkpointHeartbeatFailure: Error | undefined;
      let checkpointHeartbeatTerminal: Promise<never> | undefined;
      const runnerController = new AbortController();
      const forwardActivityCancellation = (): void => {
        runnerController.abort(activityContext.cancellationSignal.reason);
      };
      activityContext.cancellationSignal.addEventListener('abort', forwardActivityCancellation, {
        once: true,
      });
      if (activityContext.cancellationSignal.aborted) forwardActivityCancellation();
      const heartbeatCheckpoint = (value: SessionCheckpoint): Promise<void> => {
        const operation = checkpointHeartbeatTail.then(async () => {
          if (checkpointHeartbeatTerminal !== undefined) return checkpointHeartbeatTerminal;
          try {
            await activityContext.client.activity.heartbeat(activityContext.info.taskToken, value);
          } catch (error: unknown) {
            if (error instanceof ActivityCancelledError) {
              runnerController.abort(error);
              checkpointHeartbeatTerminal = activityContext.client.activity
                .reportCancellation(activityContext.info.taskToken)
                .then(() => {
                  throw new CompleteAsyncError();
                });
              return checkpointHeartbeatTerminal;
            }
            throw error;
          }
        });
        checkpointHeartbeatTail = operation.catch(() => undefined);
        return operation;
      };
      const transcripts = new CheckpointTranscriptStore(
        checkpoint.transcript,
        async (transcript) => {
          const next = SessionCheckpointSchema.parse({ ...checkpoint, transcript });
          if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_TEMPORAL_TRANSCRIPT_BYTES) {
            throw new Error('Session checkpoint exceeds the Temporal payload size limit');
          }
          checkpoint = next;
          await heartbeatCheckpoint(next);
        },
      );
      const sendHeartbeat = (): void => {
        void heartbeatCheckpoint(checkpoint).catch((error: unknown) => {
          checkpointHeartbeatFailure =
            error instanceof Error ? error : new Error('Temporal checkpoint heartbeat failed');
          runnerController.abort(checkpointHeartbeatFailure);
        });
      };
      const timer = setInterval(sendHeartbeat, heartbeatIntervalMs);
      sendHeartbeat();
      try {
        const result = await runner.run(input, {
          resumeCheckpoint: checkpoint,
          transcripts,
          signal: runnerController.signal,
          events: {
            emit: async (sessionEvent) => {
              if (options.publishSessionEvent === undefined) {
                throw new Error('Session event publishing is not configured');
              }
              await options.publishSessionEvent(
                sessionEventToPendingAgentEvent(
                  {
                    organizationId: input.organizationId,
                    projectId: input.projectId,
                    runId: input.runId,
                  },
                  sessionEvent,
                ),
              );
            },
          },
        });
        clearInterval(timer);
        await checkpointHeartbeatTail;
        if (checkpointHeartbeatFailure !== undefined) throw checkpointHeartbeatFailure;
        return SessionResultSchema.parse(result);
      } finally {
        clearInterval(timer);
        activityContext.cancellationSignal.removeEventListener(
          'abort',
          forwardActivityCancellation,
        );
      }
    },
  };
}
