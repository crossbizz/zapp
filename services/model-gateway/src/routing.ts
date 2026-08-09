import type { CompletionRouteAttempt } from '@zapp/contracts';
import { ModelsConfigSchema, type ModelsConfig, type ProviderId } from './models.js';
import { ModelTerminalError, ProviderAttemptError, type ProviderAdapter } from './providers/types.js';
import type { BackendStreamEvent, CompleteRequest } from './schemas.js';
import { createModelAttemptTelemetry, type ModelAttemptTelemetry } from './telemetry.js';
import type { ReservableCompletionBackend } from './usage-client.js';
import { z } from 'zod';

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const DEFAULT_MAX_CONCURRENT_STREAMS = 8;

const MaxConcurrentStreamsSchema = z.number().int().positive();
const OrganizationModelPolicySchema = z
  .object({
    roles: z
      .object({
        planner: ModelsConfigSchema.shape.roles.shape.planner.optional(),
        builder: ModelsConfigSchema.shape.roles.shape.builder.optional(),
        verifier: ModelsConfigSchema.shape.roles.shape.verifier.optional(),
        summarizer: ModelsConfigSchema.shape.roles.shape.summarizer.optional(),
      })
      .strict(),
  })
  .strict();

type AgentRole = CompleteRequest['agentRole'];
type ModelRoute = ModelsConfig['roles'][AgentRole];
type OrganizationModelPolicy = z.infer<typeof OrganizationModelPolicySchema>;

export type ModelRoutingObservation =
  | {
      readonly type: 'model.attempt';
      readonly organizationId: string;
      readonly runId: string;
      readonly taskId: string | undefined;
      readonly agentRole: AgentRole;
      readonly model: string;
      readonly attempt: number;
      readonly timestamp: number;
    }
  | {
      readonly type: 'model.fallback';
      readonly organizationId: string;
      readonly runId: string;
      readonly taskId: string | undefined;
      readonly agentRole: AgentRole;
      readonly from: string;
      readonly to: string;
      readonly timestamp: number;
    };

export interface OrganizationModelPolicies {
  readonly getPolicy: (organizationId: string) => OrganizationModelPolicy | undefined | Promise<OrganizationModelPolicy | undefined>;
}

export interface RoutingDependencies {
  readonly organizationPolicies?: OrganizationModelPolicies;
  readonly observe?: (observation: ModelRoutingObservation) => void | Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly jitter?: (milliseconds: number) => number;
  readonly now?: () => number;
  readonly maxConcurrentStreams?: number;
  readonly telemetry?: ModelAttemptTelemetry;
}

export interface CreateRoutingCompletionOptions {
  readonly models: ModelsConfig;
  readonly providers: Partial<Record<ProviderId, ProviderAdapter>>;
  readonly routing?: RoutingDependencies;
}

interface SemaphoreWaiter {
  readonly grant: () => void;
}

interface SemaphoreState {
  inUse: number;
  readonly waiters: SemaphoreWaiter[];
}

class OrganizationStreamSemaphore {
  private readonly states = new Map<string, SemaphoreState>();

  constructor(private readonly limit: number) {}

  acquire(organizationId: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError());

    const state = this.states.get(organizationId) ?? { inUse: 0, waiters: [] };
    this.states.set(organizationId, state);
    if (state.inUse < this.limit) {
      state.inUse += 1;
      return Promise.resolve(this.release(organizationId, state));
    }

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const waiterIndex = state.waiters.indexOf(waiter);
        if (waiterIndex >= 0) state.waiters.splice(waiterIndex, 1);
        this.removeIfUnused(organizationId, state);
        reject(abortError());
      };
      const waiter: SemaphoreWaiter = {
        grant: () => {
          signal.removeEventListener('abort', onAbort);
          resolve(this.release(organizationId, state));
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      state.waiters.push(waiter);
    });
  }

  private release(organizationId: string, state: SemaphoreState): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.waiters.shift();
      if (next !== undefined) {
        next.grant();
        return;
      }
      state.inUse -= 1;
      this.removeIfUnused(organizationId, state);
    };
  }

  private removeIfUnused(organizationId: string, state: SemaphoreState): void {
    if (state.inUse === 0 && state.waiters.length === 0) this.states.delete(organizationId);
  }
}

function abortError(): Error {
  const error = new Error('model completion aborted');
  error.name = 'AbortError';
  return error;
}

function defaultJitter(milliseconds: number): number {
  return Math.floor(milliseconds * (0.5 + Math.random()));
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function retryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    readonly status?: unknown;
    readonly statusCode?: unknown;
    readonly code?: unknown;
    readonly name?: unknown;
    readonly isRetryable?: unknown;
  };
  const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  if (typeof status === 'number') {
    return status === 408 || status === 429 || (status >= 500 && status < 600);
  }
  return (
    candidate.isRetryable === true ||
    candidate.name === 'TimeoutError' ||
    candidate.code === 'ETIMEDOUT' ||
    candidate.code === 'ESOCKETTIMEDOUT' ||
    candidate.code === 'ECONNABORTED'
  );
}

function providerFor(reference: string, providers: CreateRoutingCompletionOptions['providers']) {
  const separator = reference.indexOf('/');
  const providerId = reference.slice(0, separator) as ProviderId;
  const modelId = reference.slice(separator + 1);
  const provider = providers[providerId];
  if (provider === undefined) throw new Error(`model provider ${providerId} is disabled`);
  return { provider, providerId, modelId };
}

function routeAttempt(reference: string, request: CompleteRequest): CompletionRouteAttempt {
  const separator = reference.indexOf('/');
  return {
    provider: reference.slice(0, separator),
    model: reference.slice(separator + 1),
    maxInputTokens: request.maxInputTokens,
    maxOutputTokens: request.maxOutputTokens,
  };
}

async function routeFor(
  request: CompleteRequest,
  models: ModelsConfig,
  organizationPolicies: OrganizationModelPolicies | undefined,
): Promise<ModelRoute> {
  const policy = await organizationPolicies?.getPolicy(request.organizationId);
  const parsed = policy === undefined ? undefined : OrganizationModelPolicySchema.parse(policy);
  return parsed?.roles[request.agentRole] ?? models.roles[request.agentRole];
}

export function createRoutingCompletion(options: CreateRoutingCompletionOptions): ReservableCompletionBackend {
  const routing = options.routing;
  const semaphore = new OrganizationStreamSemaphore(
    MaxConcurrentStreamsSchema.parse(routing?.maxConcurrentStreams ?? DEFAULT_MAX_CONCURRENT_STREAMS),
  );
  const observe = routing?.observe ?? (() => undefined);
  const sleep = routing?.sleep ?? defaultSleep;
  const jitter = routing?.jitter ?? defaultJitter;
  const now = routing?.now ?? Date.now;
  const telemetry = routing?.telemetry ?? createModelAttemptTelemetry({ now });

  const streamPinned = (
    request: CompleteRequest,
    route: ModelRoute,
    signal: AbortSignal,
  ): AsyncIterable<BackendStreamEvent> =>
    (async function* () {
        const release = await semaphore.acquire(request.organizationId, signal);
        try {
          const references = [route.primary, ...route.fallbacks];
          let lastFailure: unknown;

          for (const [routeIndex, reference] of references.entries()) {
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
              if (signal.aborted) throw abortError();
              await observe({
                type: 'model.attempt',
                organizationId: request.organizationId,
                runId: request.runId,
                taskId: request.taskId,
                agentRole: request.agentRole,
                model: reference,
                attempt,
                timestamp: now(),
              });
              let emitted = false;
              const separator = reference.indexOf('/');
              const attemptSpan = telemetry.start({
                provider: reference.slice(0, separator),
                model: reference.slice(separator + 1),
                attempt,
                organizationId: request.organizationId,
                runId: request.runId,
                taskId: request.taskId,
              });
              try {
                const { provider, modelId } = providerFor(reference, options.providers);
                for await (const event of provider.stream({ modelId, request, signal })) {
                  emitted = true;
                  if (event.type === 'usage') attemptSpan.recordUsage(event);
                  yield event;
                }
                attemptSpan.end('ok');
                return;
              } catch (error) {
                attemptSpan.end('error', error);
                if (error instanceof ModelTerminalError) throw error;
                const attributed =
                  error instanceof ProviderAttemptError
                    ? error
                    : new ProviderAttemptError(
                        reference.slice(0, separator),
                        reference.slice(separator + 1),
                        error,
                      );
                if (emitted || !retryable(error)) throw attributed;
                lastFailure = attributed;
                if (attempt < MAX_ATTEMPTS) {
                  await sleep(jitter(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
                  continue;
                }
              }
            }

            const fallback = references[routeIndex + 1];
            if (fallback === undefined) throw lastFailure;
            await observe({
              type: 'model.fallback',
              organizationId: request.organizationId,
              runId: request.runId,
              taskId: request.taskId,
              agentRole: request.agentRole,
              from: reference,
              to: fallback,
              timestamp: now(),
            });
          }
        } finally {
          release();
        }
      })();

  return {
    async prepare(request) {
      const route = await routeFor(request, options.models, routing?.organizationPolicies);
      return {
        route: [route.primary, ...route.fallbacks].flatMap((reference) =>
          Array.from({ length: MAX_ATTEMPTS }, () => routeAttempt(reference, request)),
        ),
        stream: (signal) => streamPinned(request, route, signal),
      };
    },
    stream(request, signal): AsyncIterable<BackendStreamEvent> {
      return (async function* () {
        const route = await routeFor(request, options.models, routing?.organizationPolicies);
        yield* streamPinned(request, route, signal);
      })();
    },
  };
}
