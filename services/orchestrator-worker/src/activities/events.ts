import { createHash } from 'node:crypto';

import { AgentEventInputObjectSchema, AgentEventInputSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';
import type { SessionEvent } from '../session/loop.js';

export type PublishedAgentEvent = z.infer<typeof AgentEventInputSchema>;

export const PendingAgentEventSchema = AgentEventInputObjectSchema.extend({
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
    status: z.enum([
      'running',
      'paused',
      'waiting_for_approval',
      'completed',
      'failed',
      'cancelled',
    ]),
    idempotencyKey: z.string().min(1).max(512),
  })
  .strict();
export type RunStatusTransition = z.infer<typeof RunStatusTransitionSchema>;

const EmitEventsInputSchema = z
  .object({
    events: z.array(PendingAgentEventSchema).min(1).max(20),
    flushImmediately: z.boolean().optional(),
  })
  .strict();
export type EmitEventsInput = z.infer<typeof EmitEventsInputSchema>;

export const StoreAssistantContentInputSchema = z
  .object({
    artifactId: idSchema('art'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    runId: idSchema('run'),
    content: z.string().min(1).max(1_000_000),
    idempotencyKey: z.string().min(1).max(512),
  })
  .strict();
export type StoreAssistantContentInput = z.infer<typeof StoreAssistantContentInputSchema>;

const StoredAssistantContentSchema = z
  .object({ artifactId: idSchema('art'), contentHash: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
export type StoredAssistantContent = z.infer<typeof StoredAssistantContentSchema>;

export interface AssistantContentStore {
  store(
    input: StoreAssistantContentInput & { readonly contentHash: string },
  ): Promise<StoredAssistantContent>;
}

export function sessionEventToPendingAgentEvent(
  scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly runId: string;
  },
  sessionEvent: SessionEvent,
): PendingAgentEvent {
  const taskId = /^task_[0-9A-HJKMNP-TV-Z]{26}$/u.test(sessionEvent.taskId)
    ? sessionEvent.taskId
    : undefined;
  return PendingAgentEventSchema.parse({
    eventKey: sessionEvent.eventKey,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    runId: scope.runId,
    ...(taskId === undefined ? {} : { taskId }),
    agentId: 'builder',
    occurredAt: sessionEvent.occurredAt,
    type: sessionEvent.type,
    visibility: 'user',
    payload: sessionEvent.payload,
  });
}

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
    return this.enqueue(eventValue).completion;
  }

  async emitMany(
    eventValues: readonly PendingAgentEvent[],
    options: { readonly flushImmediately?: boolean } = {},
  ): Promise<void> {
    const queued = eventValues.map((event) => this.enqueue(event));
    if (options.flushImmediately === true) {
      const states = new Map(queued.map(({ scope, state }) => [scope, state]));
      states.forEach((state, scope) => {
        this.requestFlush(scope, state);
      });
    }
    await Promise.all(queued.map(({ completion }) => completion));
  }

  private enqueue(eventValue: PendingAgentEvent): QueuedEvent & {
    readonly completion: Promise<void>;
    readonly scope: string;
    readonly state: QueueState;
  } {
    const event = PendingAgentEventSchema.parse(eventValue);
    const scope = `${event.organizationId}\n${event.projectId}\n${event.runId}`;
    const state = this.queues.get(scope) ?? {
      queued: [],
      timer: undefined,
      tail: Promise.resolve(),
    };
    this.queues.set(scope, state);
    let queuedEvent!: QueuedEvent;
    const completion = new Promise<void>((resolve, reject) => {
      queuedEvent = { event, resolve, reject };
      state.queued.push(queuedEvent);
    });
    if (state.queued.length >= 20) {
      this.requestFlush(scope, state);
    } else if (state.timer === undefined) {
      state.timer = setTimeout(() => {
        this.requestFlush(scope, state);
      }, this.flushIntervalMs);
    }
    return { ...queuedEvent, completion, scope, state };
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
  emitEvents(input: EmitEventsInput): Promise<void>;
  storeAssistantContent(input: StoreAssistantContentInput): Promise<StoredAssistantContent>;
  transitionRunStatus(input: RunStatusTransition): Promise<void>;
}

export interface EventActivityDependencies {
  readonly client: EventBatchClient;
  readonly assistantContent: AssistantContentStore;
  readonly transitionStatus: (input: RunStatusTransition) => Promise<void>;
}

export function createEventActivities(dependencies: EventActivityDependencies): EventActivities {
  const assistantContent = (dependencies as Partial<EventActivityDependencies>).assistantContent;
  if (assistantContent === undefined) {
    throw new Error('Assistant content storage is required');
  }
  return {
    async emitEvents(inputValue) {
      const input = EmitEventsInputSchema.parse(inputValue);
      await dependencies.client.emitMany(
        input.events,
        input.flushImmediately === undefined
          ? {}
          : { flushImmediately: input.flushImmediately },
      );
    },
    async storeAssistantContent(inputValue) {
      const input = StoreAssistantContentInputSchema.parse(inputValue);
      const contentHash = createHash('sha256').update(input.content).digest('hex');
      const stored = await assistantContent.store({ ...input, contentHash });
      if (stored.artifactId !== input.artifactId || stored.contentHash !== contentHash) {
        throw new Error('Assistant content storage returned a mismatched receipt');
      }
      return StoredAssistantContentSchema.parse(stored);
    },
    async transitionRunStatus(inputValue) {
      const input = RunStatusTransitionSchema.parse(inputValue);
      await dependencies.transitionStatus(input);
    },
  };
}
