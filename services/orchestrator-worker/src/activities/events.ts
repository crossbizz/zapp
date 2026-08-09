import { createHash } from 'node:crypto';

import { AgentEventSchema } from '@zapp/contracts';
import { z } from 'zod';

const AgentEventInputSchema = AgentEventSchema.omit({ id: true, sequence: true }).strict();
export type PublishedAgentEvent = z.infer<typeof AgentEventInputSchema>;

export const PendingAgentEventSchema = AgentEventInputSchema.extend({
  eventKey: z.string().min(1).max(1_024),
}).strict();
export type PendingAgentEvent = z.infer<typeof PendingAgentEventSchema>;

const EventBatchSchema = z
  .object({
    events: z.array(AgentEventInputSchema).min(1).max(20),
    idempotencyKey: z.string().min(1).max(512),
  })
  .strict();
export type EventBatch = z.infer<typeof EventBatchSchema>;

export const RunStatusTransitionSchema = z
  .object({
    runId: z.string().min(1),
    status: z.enum(['running', 'waiting_for_approval', 'completed', 'failed', 'cancelled']),
    idempotencyKey: z.string().min(1).max(512),
  })
  .strict();
export type RunStatusTransition = z.infer<typeof RunStatusTransitionSchema>;

export interface EventBatchClientOptions {
  readonly flushIntervalMs?: number;
  readonly publish: (batch: EventBatch) => Promise<void>;
}

interface QueuedEvent {
  readonly event: PendingAgentEvent;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface QueueState {
  readonly queued: QueuedEvent[];
  timer: ReturnType<typeof setTimeout> | undefined;
  tail: Promise<void>;
}

function batchKey(events: readonly PendingAgentEvent[]): string {
  const digest = createHash('sha256')
    .update(events.map((event) => event.eventKey).join('\n'))
    .digest('hex');
  return `op_${digest}`;
}

/** CP-13 client with a hard batch cap and a bounded linger before flushing. */
export class EventBatchClient {
  private readonly flushIntervalMs: number;
  private readonly publish: EventBatchClientOptions['publish'];
  private readonly queues = new Map<string, QueueState>();

  constructor(options: EventBatchClientOptions) {
    this.flushIntervalMs = z
      .number()
      .int()
      .nonnegative()
      .max(1_000)
      .parse(options.flushIntervalMs ?? 1_000);
    this.publish = options.publish;
  }

  emit(eventValue: PendingAgentEvent): Promise<void> {
    const event = PendingAgentEventSchema.parse(eventValue);
    const scope = `${event.organizationId}\n${event.projectId}\n${event.runId}`;
    const state = this.queues.get(scope) ?? {
      queued: [],
      timer: undefined,
      tail: Promise.resolve(),
    };
    this.queues.set(scope, state);
    const completion = new Promise<void>((resolve, reject) => {
      state.queued.push({ event, resolve, reject });
    });
    if (state.queued.length >= 20) {
      this.requestFlush(scope, state);
    } else if (state.timer === undefined) {
      state.timer = setTimeout(() => {
        this.requestFlush(scope, state);
      }, this.flushIntervalMs);
    }
    return completion;
  }

  private requestFlush(scope: string, state: QueueState): void {
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
    const entries = state.queued.splice(0, 20);
    if (entries.length === 0) return;
    const pendingEvents = entries.map((entry) => entry.event);
    const events: PublishedAgentEvent[] = pendingEvents.map((event) =>
      AgentEventInputSchema.parse({
        runId: event.runId,
        organizationId: event.organizationId,
        projectId: event.projectId,
        occurredAt: event.occurredAt,
        ...(event.phaseId === undefined ? {} : { phaseId: event.phaseId }),
        ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
        ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
        type: event.type,
        visibility: event.visibility,
        payload: event.payload,
      }),
    );
    const batch = EventBatchSchema.parse({ events, idempotencyKey: batchKey(pendingEvents) });
    const published = state.tail.then(() => this.publish(batch));
    state.tail = published.catch(() => undefined);
    void published.then(
      () => {
        entries.forEach((entry) => {
          entry.resolve();
        });
      },
      (error: unknown) => {
        entries.forEach((entry) => {
          entry.reject(error);
        });
      },
    );
    if (state.queued.length >= 20) this.requestFlush(scope, state);
    else if (state.queued.length > 0) {
      state.timer = setTimeout(() => {
        this.requestFlush(scope, state);
      }, this.flushIntervalMs);
    }
    const drain = state.tail;
    void drain.then(() => {
      if (
        state.tail === drain &&
        state.queued.length === 0 &&
        state.timer === undefined
      ) {
        this.queues.delete(scope);
      }
    });
  }
}

export interface EventActivities {
  emitEvents(input: { readonly events: readonly PendingAgentEvent[] }): Promise<void>;
  transitionRunStatus(input: RunStatusTransition): Promise<void>;
}

export interface EventActivityDependencies {
  readonly client: EventBatchClient;
  readonly transitionStatus: (input: RunStatusTransition) => Promise<void>;
}

export function createEventActivities(dependencies: EventActivityDependencies): EventActivities {
  return {
    async emitEvents(inputValue) {
      const input = z
        .object({ events: z.array(PendingAgentEventSchema).min(1).max(20) })
        .strict()
        .parse(inputValue);
      await Promise.all(input.events.map((event) => dependencies.client.emit(event)));
    },
    async transitionRunStatus(inputValue) {
      const input = RunStatusTransitionSchema.parse(inputValue);
      await dependencies.transitionStatus(input);
    },
  };
}
