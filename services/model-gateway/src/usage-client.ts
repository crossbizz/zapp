import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import {
  ModelCompletionClaimRequestSchema,
  ModelCompletionClaimResponseSchema,
  ModelCompletionCommitRequestSchema,
  ModelCompletionCommitResponseSchema,
  type CompletionRecord,
  type CompletionRouteAttempt,
  type CompletionUsage,
  type ModelCompletionClaimRequest,
  type ModelCompletionClaimResponse,
  type ModelCompletionCommitRequest,
  type ModelCompletionCommitResponse,
} from '@zapp/contracts';
import { z } from 'zod';

import type { CompletionBackend } from './app.js';
import { ModelTerminalError, ProviderAttemptError } from './providers/types.js';
import {
  BackendStreamEventSchema,
  type AccountingReplay,
  type BackendStreamEvent,
  type CompleteRequest,
} from './schemas.js';

const MODEL_COMPLETIONS_AUDIENCE = 'control-api:model-completions' as const;
const LEASE_MS = 300_000;

export interface CompletionUsageClient {
  claim(input: ModelCompletionClaimRequest): Promise<ModelCompletionClaimResponse>;
  commit(input: ModelCompletionCommitRequest): Promise<ModelCompletionCommitResponse>;
}

export interface ReservableCompletionBackend extends CompletionBackend {
  prepare(request: CompleteRequest): Promise<{
    readonly route: readonly CompletionRouteAttempt[];
    readonly stream: (signal: AbortSignal) => AsyncIterable<BackendStreamEvent>;
  }>;
}

export class CompletionControlError extends Error {
  constructor(
    readonly code: 'completion_leased' | 'budget_exceeded',
    readonly retryable: boolean,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'CompletionControlError';
  }
}

export class CompletionCommitIndeterminateError extends Error {
  constructor(cause: unknown) {
    super('The durable completion commit outcome is unknown.', { cause });
    this.name = 'CompletionCommitIndeterminateError';
  }
}

export interface ControlPlaneUsageClientOptions {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new Error('The completion accounting service returned invalid JSON.', { cause: error });
  }
}

export function createControlPlaneUsageClient(
  options: ControlPlaneUsageClientOptions,
): CompletionUsageClient {
  const baseUrl = z.string().url().parse(options.baseUrl);
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const { token } = await signer.signServiceToken({
      service: 'model-gateway',
      aud: MODEL_COMPLETIONS_AUDIENCE,
    });
    let response: Response;
    try {
      response = await doFetch(new URL(path, baseUrl).toString(), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'cache-control': 'no-store',
          'content-type': 'application/json',
          'x-zapp-service-token': token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error('The completion accounting service could not be reached.', { cause: error });
    }
    if (response.status !== 200) {
      throw new Error(
        `The completion accounting service refused the request (${String(response.status)}).`,
      );
    }
    return await responseJson(response);
  };
  return {
    async claim(inputValue) {
      const input = ModelCompletionClaimRequestSchema.parse(inputValue);
      return ModelCompletionClaimResponseSchema.parse(
        await post('/internal/model-completions/claim', input),
      );
    },
    async commit(inputValue) {
      const input = ModelCompletionCommitRequestSchema.parse(inputValue);
      return ModelCompletionCommitResponseSchema.parse(
        await post(
          `/internal/model-completions/${encodeURIComponent(input.completionId)}/commit`,
          input,
        ),
      );
    },
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function requestFingerprint(request: CompleteRequest): string {
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
}

function identity(request: CompleteRequest, accountingReplay?: AccountingReplay) {
  return {
    completionId: request.completionId,
    organizationId: request.organizationId,
    projectId: request.projectId,
    runId: request.runId,
    ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
    requestFingerprint: accountingReplay?.requestFingerprint ?? requestFingerprint(request),
  };
}

function terminalError(terminal: CompletionRecord['terminal']): ModelTerminalError | undefined {
  return terminal.type === 'error'
    ? new ModelTerminalError(terminal.code, terminal.message)
    : undefined;
}

function recordedEvent(
  completion: CompletionRecord,
  credits: ModelCompletionCommitResponse['credits'],
): BackendStreamEvent {
  return BackendStreamEventSchema.parse({
    type: 'usage.recorded',
    completionId: completion.completionId,
    usage: completion.usage,
    credits,
  });
}

function usageFrom(
  event: Extract<BackendStreamEvent, { type: 'usage' }>,
  now: Date,
): CompletionUsage {
  return {
    provider: event.provider,
    model: event.model,
    inputTokens: event.inputTokens ?? 0,
    outputTokens: event.outputTokens ?? 0,
    cacheReadInputTokens: event.cachedInputTokens ?? 0,
    cacheWriteInputTokens: event.cacheWriteInputTokens ?? 0,
    occurredAt: now.toISOString(),
  };
}

function assertCommittedResponse(
  completion: CompletionRecord,
  expectedIdentity: ReturnType<typeof identity>,
  events: readonly BackendStreamEvent[],
  usage: readonly CompletionUsage[],
  terminal: CompletionRecord['terminal'],
): void {
  if (
    completion.completionId !== expectedIdentity.completionId ||
    completion.organizationId !== expectedIdentity.organizationId ||
    completion.projectId !== expectedIdentity.projectId ||
    completion.runId !== expectedIdentity.runId ||
    completion.taskId !== expectedIdentity.taskId ||
    completion.requestFingerprint !== expectedIdentity.requestFingerprint ||
    !isDeepStrictEqual(completion.events, events) ||
    !isDeepStrictEqual(completion.usage, usage) ||
    !isDeepStrictEqual(completion.terminal, terminal)
  ) {
    throw new Error('The completion accounting service committed a different response.');
  }
}

export function createUsageAccountedCompletion(options: {
  readonly backend: ReservableCompletionBackend;
  readonly accounting: CompletionUsageClient;
  readonly claimOwner: string;
  readonly leaseMs?: number;
  readonly leaseRenewalIntervalMs?: number;
  readonly now?: () => Date;
  readonly observe?: (event: { readonly type: 'usage.recorded' }) => void;
}): CompletionBackend {
  const claimOwnerPrefix = z.string().trim().min(1).max(160).parse(options.claimOwner);
  const leaseMs = z
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .parse(options.leaseMs ?? LEASE_MS);
  const leaseRenewalIntervalMs = z
    .number()
    .int()
    .min(1)
    .max(leaseMs - 1)
    .parse(options.leaseRenewalIntervalMs ?? Math.floor(leaseMs / 2));
  const now = options.now ?? (() => new Date());
  return {
    stream(request, signal, suppliedAccountingReplay) {
      return (async function* () {
        const claimOwner = `${claimOwnerPrefix}:${randomUUID()}`;
        const { accountingReplay: embeddedAccountingReplay, ...providerRequest } = request;
        const accountingReplay = suppliedAccountingReplay ?? embeddedAccountingReplay;
        const completionIdentity = identity(providerRequest, accountingReplay);
        const prepared = await options.backend.prepare(providerRequest);
        const claimInput = ModelCompletionClaimRequestSchema.parse({
          ...completionIdentity,
          claimOwner,
          leaseMs,
          route: prepared.route,
        });
        const claim = await options.accounting.claim(claimInput);
        if (claim.status === 'completed') {
          for (const event of claim.completion.events) yield BackendStreamEventSchema.parse(event);
          yield recordedEvent(claim.completion, claim.credits);
          const error = terminalError(claim.completion.terminal);
          if (error !== undefined) throw error;
          return;
        }
        if (claim.status === 'leased') {
          throw new CompletionControlError(
            'completion_leased',
            true,
            'The model completion is owned by another live gateway.',
            claim.retryAfterMs,
          );
        }
        if (claim.status === 'budget_exceeded') {
          throw new CompletionControlError(
            'budget_exceeded',
            false,
            'The run credit budget is exhausted.',
          );
        }

        const events: BackendStreamEvent[] = [];
        const normalizedUsage: CompletionUsage[] = [];
        let terminal: CompletionRecord['terminal'] = { type: 'done' };
        const renewalStop = new AbortController();
        const leaseLost = new AbortController();
        let renewalError: unknown;
        const renewalTask = (async (): Promise<void> => {
          while (
            await new Promise<boolean>((resolve) => {
              let finished = false;
              const finish = (elapsed: boolean): void => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                renewalStop.signal.removeEventListener('abort', onAbort);
                resolve(elapsed);
              };
              const onAbort = (): void => {
                finish(false);
              };
              const timer = setTimeout(() => {
                finish(true);
              }, leaseRenewalIntervalMs);
              renewalStop.signal.addEventListener('abort', onAbort, { once: true });
              if (renewalStop.signal.aborted) finish(false);
            })
          ) {
            const renewed = await options.accounting.claim(claimInput);
            if (renewed.status === 'claimed') continue;
            if (renewed.status === 'leased') {
              throw new CompletionControlError(
                'completion_leased',
                true,
                'The model completion lease was lost before accounting completed.',
                renewed.retryAfterMs,
              );
            }
            if (renewed.status === 'budget_exceeded') {
              throw new CompletionControlError(
                'budget_exceeded',
                false,
                'The run credit budget was exhausted while the completion was active.',
              );
            }
            throw new CompletionCommitIndeterminateError(
              new Error('The completion changed state while its lease was being renewed.'),
            );
          }
        })().catch((error: unknown) => {
          renewalError = error;
          leaseLost.abort(error);
        });
        const providerSignal = AbortSignal.any([signal, leaseLost.signal]);
        const providerIterator = prepared.stream(providerSignal)[Symbol.asyncIterator]();
        let providerFinished = false;
        let settlementStarted = false;

        const recordProviderEvent = (value: unknown): BackendStreamEvent => {
          const event = BackendStreamEventSchema.parse(value);
          if (event.type === 'usage.recorded') {
            throw new Error('The provider backend cannot emit accounting events.');
          }
          events.push(event);
          if (event.type === 'usage') normalizedUsage.push(usageFrom(event, now()));
          return event;
        };
        const recordProviderError = (error: unknown): void => {
          if (error instanceof ModelTerminalError) {
            terminal = { type: 'error', code: error.code, message: error.message };
          } else if (error instanceof ProviderAttemptError) {
            terminal = {
              type: 'error',
              code: 'provider_error',
              message: 'The model provider request failed.',
            };
            if (normalizedUsage.length === 0) {
              normalizedUsage.push({
                provider: error.provider,
                model: error.model,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadInputTokens: 0,
                cacheWriteInputTokens: 0,
                occurredAt: now().toISOString(),
              });
            }
          } else {
            throw error;
          }
        };
        const drainProvider = async (): Promise<void> => {
          while (!providerFinished) {
            try {
              const next = await providerIterator.next();
              if (next.done) {
                providerFinished = true;
                return;
              }
              recordProviderEvent(next.value);
            } catch (error) {
              providerFinished = true;
              recordProviderError(error);
            }
          }
        };
        const settle = async (): Promise<ModelCompletionCommitResponse> => {
          renewalStop.abort();
          await renewalTask;
          if (renewalError instanceof CompletionControlError) throw renewalError;
          if (renewalError !== undefined)
            throw new CompletionCommitIndeterminateError(renewalError);
          if (normalizedUsage.length === 0) {
            throw new CompletionCommitIndeterminateError(
              new Error('The provider completed without attributed usage.'),
            );
          }

          let committed: ModelCompletionCommitResponse;
          try {
            committed = await options.accounting.commit(
              ModelCompletionCommitRequestSchema.parse({
                ...completionIdentity,
                claimOwner,
                events,
                usage: normalizedUsage,
                terminal,
              }),
            );
          } catch (error) {
            throw new CompletionCommitIndeterminateError(error);
          }
          assertCommittedResponse(
            committed.completion,
            completionIdentity,
            events,
            normalizedUsage,
            terminal,
          );
          options.observe?.({ type: 'usage.recorded' });
          return committed;
        };

        try {
          for (;;) {
            let next: IteratorResult<BackendStreamEvent>;
            try {
              next = await providerIterator.next();
            } catch (error) {
              providerFinished = true;
              recordProviderError(error);
              break;
            }
            if (next.done) {
              providerFinished = true;
              break;
            }
            yield recordProviderEvent(next.value);
          }
          settlementStarted = true;
          const committed = await settle();
          yield recordedEvent(committed.completion, committed.credits);
          const error = terminalError(terminal);
          if (error !== undefined) throw error;
        } finally {
          if (!settlementStarted) {
            await drainProvider();
            await settle();
          } else {
            renewalStop.abort();
            await renewalTask;
          }
        }
      })();
    },
  };
}
