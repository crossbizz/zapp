import {
  AuditActionSchema,
  AuditMetadataSchema,
  AuditRecordSchema,
  AuditTargetSchema,
  idSchema,
  newId,
  type AuditActor,
  type AuditRecord,
} from '@zapp/contracts';
import { auditEvents, type Executor } from '@zapp/db';
import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The audit trail.
 *
 * Master plan §Global Constraints and PRD §22.3 require every mutating route to
 * record what was done, by whom, to what — **in the same transaction as the
 * mutation**. That last clause is the whole design of this file. An audit row
 * written after the mutation commits is a row that a crash, a rollback or a
 * lost connection can drop, and a trail with a hole in it is worse than no
 * trail: it is a trail you would believe.
 *
 * So an entry is not written *by* a route. A route passes {@link AuditHook} to
 * the store performing the mutation, the store calls it inside its own
 * transaction with the executor running it, and the hook writes through
 * `request.audit(tx, …)`. The row and the change it describes therefore commit
 * together or not at all — `test/integration/audit.test.ts` proves both
 * directions by counting rows after a deliberate failure.
 *
 * Three properties hold at the seam rather than at each call site:
 *
 *   - **The actor comes from the session.** A handler cannot claim an audit row
 *     was somebody else's doing, which is the one property that makes the trail
 *     worth keeping.
 *   - **`organizationId` is an explicit argument**, not read from
 *     `request.tenant`: two of the actions below are written by routes that have
 *     no tenant context at all — creating an organization and accepting an
 *     invitation both record an organization the caller was not yet a member of
 *     when the request began — so a trail sourced from `ctx` would be missing
 *     exactly the rows that say how someone got access.
 *   - **Metadata is scalars only** ({@link AuditMetadata}), enforced at compile
 *     time and again at runtime. This table is read years later; a nested object
 *     is how a token, a secret value or a whole request body ends up in it by
 *     accident.
 *
 * **What is deliberately not here:** the session lifecycle — sign-in, sign-out,
 * refresh, device approval. PRD §23.6 makes `audit_events.organization_id` not
 * null, and none of those events belongs to an organization: a person signs in
 * to zapp, not to a tenant, and at that moment may be a member of none or of
 * six. Filing them under a guessed organization would put one tenant's trail in
 * another's, and that is a worse answer than an honest gap. They are logged
 * (`src/routes/auth.ts`) and belong in an account-level trail whenever the PRD
 * grows one.
 */

// Kept as re-exports for existing control-api consumers. The definitions live
// in @zapp/contracts because this table has writers outside this service.
export {
  AUDIT_ACTIONS,
  AUDIT_ACTOR_TYPES,
  AUDIT_TARGET_TYPES,
  AuditActionSchema,
  AuditActorSchema,
  AuditActorTypeSchema,
  AuditMetadataSchema,
  AuditRecordSchema,
  AuditScalarSchema,
  AuditTargetSchema,
  AuditTargetTypeSchema,
  AuditValueSchema,
  type AuditAction,
  type AuditActor,
  type AuditActorType,
  type AuditMetadata,
  type AuditRecord,
  type AuditScalar,
  type AuditTarget,
  type AuditTargetType,
  type AuditValue,
} from '@zapp/contracts';

/**
 * What a store hands its audit hook where it has no transaction to offer — the
 * in-memory doubles in `test/support`, and nothing else.
 *
 * A symbol rather than a cast, so the database sink can *refuse* it: a row that
 * reached the real table outside a transaction would be the exact failure this
 * file exists to prevent, and a type assertion would have hidden it.
 */
export const NO_TRANSACTION = Symbol('no transaction');

/** Whatever is running the mutation's statements: an open transaction, or the pool handle. */
export type AuditExecutor = Executor | typeof NO_TRANSACTION;

/**
 * A store's audit hook: called inside the mutation's transaction, with the
 * executor running it and the result of the write it describes.
 *
 * Routes pass `(tx, result) => request.audit(tx, { … })` and never name the
 * executor's type — which is what keeps `src/routes/` free of `@zapp/db`
 * (`test/route-isolation.test.ts`).
 */
export type AuditHook<TResult = void> = (tx: AuditExecutor, result: TResult) => Promise<void>;

export interface AuditSink {
  /** Writes `event` through `tx`, so it shares the mutation's fate. */
  record(tx: AuditExecutor, event: AuditRecord): Promise<void>;
  /**
   * Writes `event` on its own.
   *
   * For the one mutation that has no database transaction to join: issuing an
   * invitation writes to Redis, not to PostgreSQL (`src/orgs/invites.ts`), so
   * there is nothing for the row to be atomic *with*. Ordered after the invite
   * so a failure here means the token was never returned to anybody — an invite
   * nobody holds expires unused, which is the harmless direction.
   */
  recordDetached(event: AuditRecord): Promise<void>;
  /** Idempotent detached delivery for a retryable cross-service completion. */
  recordDetachedOnce(key: string, event: AuditRecord): Promise<void>;
}

export interface InMemoryAuditSink extends AuditSink {
  readonly events: readonly AuditRecord[];
}

/**
 * Keeps the trail in memory. Correct for tests and for a single-process
 * development run, and for nothing else — an audit trail that a restart erases
 * is not an audit trail, which is why `buildApp` refuses to default to this
 * outside development.
 */
export function createInMemoryAuditSink(): InMemoryAuditSink {
  const events: AuditRecord[] = [];
  const detachedKeys = new Set<string>();

  function append(event: AuditRecord): Promise<void> {
    return new Promise((resolve) => {
      events.push(AuditRecordSchema.parse(event));
      resolve();
    });
  }

  return {
    events,
    record(_tx, event) {
      return append(event);
    },
    recordDetached(event) {
      return append(event);
    },
    recordDetachedOnce(key, event) {
      if (detachedKeys.has(key)) return Promise.resolve();
      detachedKeys.add(key);
      return append(event).catch((error: unknown) => {
        detachedKeys.delete(key);
        throw error;
      });
    },
  };
}

/**
 * The shipping sink: one `audit_events` insert, on the caller's executor.
 *
 * `audit_events` is append-only and the migration enforces it with a trigger
 * (`packages/db/drizzle/0003`, `0006`), so there is deliberately no update and
 * no delete here — a correction is another row, never an edit.
 */
export function createDbAuditSink(db: Executor): AuditSink {
  async function insert(
    tx: Executor,
    event: AuditRecord,
    id = newId('aud'),
    once = false,
  ): Promise<void> {
    const parsed = AuditRecordSchema.parse(event);
    const write = tx.insert(auditEvents).values({
      id,
      organizationId: parsed.organizationId,
      actorType: parsed.actorType,
      actorId: parsed.actorId,
      action: parsed.action,
      targetType: parsed.targetType,
      targetId: parsed.targetId,
      metadataJson: parsed.metadata,
      occurredAt: parsed.occurredAt,
    });
    if (once) {
      await write.onConflictDoNothing({ target: auditEvents.id });
    } else {
      await write;
    }
  }

  return {
    async record(tx, event) {
      if (tx === NO_TRANSACTION) {
        // Reachable only by wiring a test double into the real sink. Loud,
        // because the alternative is a row that silently is not atomic with
        // anything.
        throw new Error('the audit_events sink requires the mutation’s executor');
      }
      await insert(tx, event);
    },
    async recordDetached(event) {
      await insert(db, event);
    },
    async recordDetachedOnce(key, event) {
      await insert(db, event, stableAuditId(key), true);
    },
  };
}

function stableAuditId(key: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = createHash('sha256').update(`audit:${key}`).digest();
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < 26) {
      bits -= 5;
      output += alphabet[(value >>> bits) & 31] ?? '';
    }
    if (output.length === 26) break;
  }
  return idSchema('aud').parse(`aud_${output}`);
}

/** What a route passes; everything else is filled in from the request. */
export const AuditEntrySchema = z
  .object({
    organizationId: idSchema('org'),
    action: AuditActionSchema,
    target: AuditTargetSchema,
    metadata: AuditMetadataSchema.optional(),
  })
  .strict();
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Records one audit entry for the authenticated actor, inside the
     * mutation's own transaction. Requires a session.
     */
    audit(tx: AuditExecutor, entry: AuditEntry): Promise<void>;
    /**
     * Records one audit entry with no transaction to join. Only for a mutation
     * that does not touch PostgreSQL — see {@link AuditSink.recordDetached}.
     */
    auditDetached(entry: AuditEntry): Promise<void>;
    /** Retry-safe detached audit using one deterministic row id. */
    auditDetachedOnce(key: string, entry: AuditEntry, occurredAt: Date): Promise<void>;
    /**
     * The same, for a request authenticated as a service rather than as a person
     * (`src/internal/service-auth.ts`).
     *
     * A separate decorator rather than an `actor` field on {@link AuditEntry},
     * and the distinction is the point: the actor still comes from a verified
     * credential on the request, never from an argument. A handler cannot claim
     * a row was some other service's doing any more than it can claim a row was
     * some other user's — which is the property that makes `secret.decrypted`
     * worth reading.
     *
     * Requires `requireService`; a request with a session and no service
     * identity throws rather than silently filing the row under `user`.
     */
    auditService(tx: AuditExecutor, entry: AuditEntry): Promise<void>;
  }
}

export interface AuditLogOptions {
  readonly sink: AuditSink;
  readonly now: () => Date;
}

export const auditLog = fp<AuditLogOptions>(
  (app, options, done) => {
    const { sink, now } = options;

    function toRecord(actor: AuditActor, entry: AuditEntry, occurredAt = now()): AuditRecord {
      const parsed = AuditEntrySchema.parse(entry);
      return AuditRecordSchema.parse({
        organizationId: parsed.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: parsed.action,
        targetType: parsed.target.type,
        targetId: parsed.target.id,
        metadata: parsed.metadata ?? {},
        occurredAt,
      });
    }

    function userActor(request: FastifyRequest): AuditActor {
      const auth = request.auth;
      if (auth === undefined) {
        // Not reachable from a route with `requireSession`, which is all of
        // them. Reaching it means a mutating route was registered without one,
        // and a 500 is the honest outcome: the alternative is an audit row that
        // names no actor.
        throw new Error('audit requires an authenticated request');
      }
      return { type: 'user', id: auth.userId };
    }

    function serviceActor(request: FastifyRequest): AuditActor {
      const service = request.service;
      if (service === undefined) {
        // Same argument, and the reverse mistake: a route that called this
        // without `requireService` would file a service action under whatever
        // credential happened to be present.
        throw new Error('auditService requires a service-authenticated request');
      }
      return { type: 'service', id: service.service };
    }

    app.decorateRequest(
      'audit',
      function audit(this: FastifyRequest, tx: AuditExecutor, entry: AuditEntry): Promise<void> {
        return sink.record(tx, toRecord(userActor(this), entry));
      },
    );

    app.decorateRequest(
      'auditDetached',
      function auditDetached(this: FastifyRequest, entry: AuditEntry): Promise<void> {
        return sink.recordDetached(toRecord(userActor(this), entry));
      },
    );

    app.decorateRequest(
      'auditDetachedOnce',
      function auditDetachedOnce(
        this: FastifyRequest,
        key: string,
        entry: AuditEntry,
        occurredAt: Date,
      ): Promise<void> {
        const event = toRecord(userActor(this), entry, occurredAt);
        return sink.recordDetachedOnce(key, event);
      },
    );

    app.decorateRequest(
      'auditService',
      function auditService(
        this: FastifyRequest,
        tx: AuditExecutor,
        entry: AuditEntry,
      ): Promise<void> {
        return sink.record(tx, toRecord(serviceActor(this), entry));
      },
    );

    done();
  },
  { name: 'audit-log', fastify: '5.x' },
);
