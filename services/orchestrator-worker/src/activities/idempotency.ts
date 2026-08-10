import { createHash } from 'node:crypto';

import { ApplicationFailure } from '@temporalio/activity';
import type {
  ActivityInterceptorsFactory,
  ActivityInboundCallsInterceptor,
} from '@temporalio/worker';
import { CommitShaSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

export interface ActivityIdempotencyClaimInput {
  readonly idempotencyKey: string;
  readonly activityType: string;
  readonly inputHash: string;
  readonly ownerId: string;
  readonly leaseMs: number;
}

export type ActivityIdempotencyClaim =
  | { readonly status: 'acquired' }
  | { readonly status: 'in_progress' }
  | { readonly status: 'conflict' }
  | {
      readonly status: 'replay';
      readonly resultHash: string;
      readonly result: unknown;
    };

export interface ActivityIdempotencyStore {
  claim(input: ActivityIdempotencyClaimInput): Promise<ActivityIdempotencyClaim>;
  renew(input: {
    readonly idempotencyKey: string;
    readonly ownerId: string;
    readonly leaseMs: number;
  }): Promise<boolean>;
  complete(input: {
    readonly idempotencyKey: string;
    readonly ownerId: string;
    readonly resultHash: string;
    readonly result: unknown;
  }): Promise<boolean>;
  release(input: {
    readonly idempotencyKey: string;
    readonly ownerId: string;
  }): Promise<void>;
}

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | CanonicalJsonObject;
interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJson;
}

function canonicalize(value: unknown, ancestors: Set<object> = new Set()): CanonicalJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Activity payload contains a non-finite number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('Activity payload is not JSON serializable');
  }
  if (ancestors.has(value)) throw new TypeError('Activity payload contains a cycle');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, ancestors));
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Activity payload contains a non-plain object');
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashActivityInput(activityType: string, args: readonly unknown[]): string {
  return sha256(canonicalJson({ activityType, args }));
}

type StoredActivityResult =
  | { readonly kind: 'void' }
  | { readonly kind: 'value'; readonly value: CanonicalJson };

function encodeResult(value: unknown): StoredActivityResult {
  return value === undefined ? { kind: 'void' } : { kind: 'value', value: canonicalize(value) };
}

function decodeResult(stored: unknown): CanonicalJson | undefined {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    throw new TypeError('Stored activity result is not an envelope');
  }
  const keys = Object.keys(stored).sort();
  const kind = (stored as { readonly kind?: unknown }).kind;
  if (kind === 'void' && keys.length === 1 && keys[0] === 'kind') return undefined;
  if (kind === 'value' && keys.length === 2 && keys[0] === 'kind' && keys[1] === 'value') {
    return canonicalize((stored as { readonly value: unknown }).value);
  }
  throw new TypeError('Stored activity result envelope is invalid');
}

function hashActivityResult(value: unknown): string {
  return sha256(canonicalJson(value));
}

function idempotencyKeyOf(activityType: string, args: readonly unknown[]): string {
  if (activityType === 'verifyPhase') {
    const parsed = z.tuple([idSchema('run'), idSchema('phase'), CommitShaSchema]).safeParse(args);
    if (parsed.success) {
      const [runId, phaseId, commitSha] = parsed.data;
      return `verify-phase:${runId}:${phaseId}:${commitSha}`;
    }
    throw ApplicationFailure.nonRetryable(
      'Mutating activity verifyPhase requires exact run, phase, and commit arguments',
      'activity_idempotency_key_required',
    );
  }
  const first = args[0];
  if (typeof first === 'object' && first !== null && 'idempotencyKey' in first) {
    const key = (first as { readonly idempotencyKey?: unknown }).idempotencyKey;
    if (typeof key === 'string' && key.length > 0 && key.length <= 512) return key;
  }
  if (activityType === 'emitEvents' && typeof first === 'object' && first !== null) {
    const events = (first as { readonly events?: unknown }).events;
    if (
      Array.isArray(events) &&
      events.length > 0 &&
      events.every(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { readonly eventKey?: unknown }).eventKey === 'string',
      )
    ) {
      const runId = (events[0] as { readonly runId?: unknown }).runId;
      if (typeof runId !== 'string' || runId.length === 0 || runId.length > 512) {
        throw ApplicationFailure.nonRetryable(
          'Mutating activity emitEvents requires a run-scoped idempotency key',
          'activity_idempotency_key_required',
        );
      }
      return `${runId}:events:${sha256(
        events
          .map((entry) => (entry as { readonly eventKey: string }).eventKey)
          .join('\n'),
      )}`;
    }
  }
  throw ApplicationFailure.nonRetryable(
    `Mutating activity ${activityType} requires an idempotency key`,
    'activity_idempotency_key_required',
  );
}

function conflictFailure(): ApplicationFailure {
  return ApplicationFailure.nonRetryable(
    'Activity idempotency key was reused for different input',
    'activity_idempotency_conflict',
  );
}

function leaseLostFailure(): ApplicationFailure {
  return ApplicationFailure.create({
    message: 'Activity idempotency lease was lost',
    type: 'activity_idempotency_lease_lost',
    nonRetryable: false,
  });
}

export interface ExecuteIdempotentActivityOptions {
  readonly store: ActivityIdempotencyStore;
  readonly activityType: string;
  readonly args: readonly unknown[];
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly renewIntervalMs: number;
  readonly next: () => Promise<unknown>;
}

export async function executeIdempotentActivity(
  options: ExecuteIdempotentActivityOptions,
): Promise<unknown> {
  const idempotencyKey = idempotencyKeyOf(options.activityType, options.args);
  const inputHash = hashActivityInput(options.activityType, options.args);
  const claim = await options.store.claim({
    idempotencyKey,
    activityType: options.activityType,
    inputHash,
    ownerId: options.ownerId,
    leaseMs: options.leaseMs,
  });
  switch (claim.status) {
    case 'conflict':
      throw conflictFailure();
    case 'in_progress':
      throw ApplicationFailure.create({
        message: 'Another activity attempt owns this idempotency key',
        type: 'activity_idempotency_in_progress',
        nonRetryable: false,
        nextRetryDelay: options.leaseMs,
      });
    case 'replay': {
      let result: CanonicalJson | undefined;
      try {
        if (hashActivityResult(claim.result) !== claim.resultHash) throw new TypeError('hash mismatch');
        result = decodeResult(claim.result);
      } catch {
        throw ApplicationFailure.nonRetryable(
          'Stored activity idempotency result does not match its hash',
          'activity_idempotency_corrupt',
        );
      }
      return result;
    }
    case 'acquired':
      break;
  }

  let renewalFailure: unknown;
  let renewalTail = Promise.resolve();
  const renew = (): void => {
    renewalTail = renewalTail
      .then(async () => {
        const renewed = await options.store.renew({
          idempotencyKey,
          ownerId: options.ownerId,
          leaseMs: options.leaseMs,
        });
        if (!renewed) throw leaseLostFailure();
      })
      .catch((error: unknown) => {
        renewalFailure ??= error;
      });
  };
  const timer = setInterval(renew, options.renewIntervalMs);
  timer.unref();
  try {
    const storedResult = encodeResult(await options.next());
    clearInterval(timer);
    await renewalTail;
    if (renewalFailure !== undefined) {
      throw renewalFailure instanceof Error
        ? renewalFailure
        : new Error('Activity idempotency lease renewal failed');
    }
    const completed = await options.store.complete({
      idempotencyKey,
      ownerId: options.ownerId,
      resultHash: hashActivityResult(storedResult),
      result: storedResult,
    });
    if (!completed) throw leaseLostFailure();
    return decodeResult(storedResult);
  } catch (error: unknown) {
    clearInterval(timer);
    await renewalTail;
    await options.store.release({ idempotencyKey, ownerId: options.ownerId });
    throw error;
  }
}

export interface ActivityIdempotencyInterceptorOptions {
  readonly store: ActivityIdempotencyStore;
  readonly leaseMs?: number;
  readonly renewIntervalMs?: number;
}

export function createActivityIdempotencyInterceptor(
  options: ActivityIdempotencyInterceptorOptions,
): ActivityInterceptorsFactory {
  const leaseMs = options.leaseMs ?? 30_000;
  const renewIntervalMs = options.renewIntervalMs ?? 10_000;
  if (leaseMs <= 0 || renewIntervalMs <= 0 || renewIntervalMs >= leaseMs) {
    throw new TypeError('Activity idempotency lease intervals are invalid');
  }
  return (context) => {
    const inbound: ActivityInboundCallsInterceptor = {
      execute: (input, next) =>
        executeIdempotentActivity({
          store: options.store,
          activityType: context.info.activityType,
          args: input.args,
          ownerId: sha256(context.info.base64TaskToken),
          leaseMs,
          renewIntervalMs,
          next: () => next(input),
        }),
    };
    return { inbound };
  };
}
