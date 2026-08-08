import { activityInfo, Context, heartbeat } from '@temporalio/activity';
import { idSchema, RunModeSchema } from '@zapp/contracts';
import { z } from 'zod';

import {
  createSessionLoop,
  SessionInputSchema,
  SessionResultSchema,
  type SessionInput,
  type SessionResult,
} from '../session/loop.js';

export const SessionCheckpointSchema = z
  .object({ runId: idSchema('run'), taskId: z.string().min(1) })
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
    budget: z
      .object({ maxCredits: z.number().int().positive().max(1_000_000) })
      .strict()
      .nullable(),
    idempotencyKey: z.string().min(1).max(512),
  })
  .strict();
export type RunBuilderSessionInput = z.infer<typeof RunBuilderSessionInputSchema>;

export interface BuilderSessionContext {
  readonly resumeCheckpoint: SessionCheckpoint | undefined;
  readonly signal: AbortSignal;
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
}

/** Binds the coarse durable-run input to the exact AR-6 session-loop contract. */
export function adaptSessionLoop(
  loop: Pick<ReturnType<typeof createSessionLoop>, 'run'>,
  buildInput: (input: RunBuilderSessionInput) => SessionInput,
): BuilderSessionRunner {
  return {
    run(input, context) {
      return loop.run(SessionInputSchema.parse(buildInput(input)), context.signal);
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
    .parse(options.heartbeatIntervalMs ?? 10_000);
  return {
    async runBuilderSession(inputValue) {
      const input = RunBuilderSessionInputSchema.parse(inputValue);
      const checkpoint =
        SessionCheckpointSchema.optional().parse(activityInfo().heartbeatDetails) ??
        SessionCheckpointSchema.parse({ runId: input.runId, taskId: 'm1-builder' });
      const sendHeartbeat = (): void => {
        heartbeat(checkpoint);
      };
      const timer = setInterval(sendHeartbeat, heartbeatIntervalMs);
      sendHeartbeat();
      try {
        const result = await runner.run(input, {
          resumeCheckpoint: checkpoint,
          signal: Context.current().cancellationSignal,
        });
        return SessionResultSchema.parse(result);
      } finally {
        clearInterval(timer);
      }
    },
  };
}
