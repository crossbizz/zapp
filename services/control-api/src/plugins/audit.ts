import { newId } from '@zapp/contracts';
import { auditEvents, type Executor } from '@zapp/db';
import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

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

/**
 * Actions this service records, as a closed set — the vocabulary a support or
 * compliance query is written against, so a typo must not be able to invent a
 * new one. Later tasks extend the list; nothing removes from it.
 */
export const AUDIT_ACTIONS = [
  'organization.created',
  'organization.updated',
  'member.invited',
  'member.joined',
  'member.role_changed',
  'member.removed',
  'project.created',
  'project.updated',
  /**
   * A capability scan was asked for. Recorded even though nothing is enqueued
   * yet (plan 05 VF-3 owns the pipeline): the request is what a support question
   * asks about, and a trail that starts only once the feature is finished has a
   * hole in exactly the period people ask about.
   */
  'project.scan_requested',
  'specification.created',
  'specification.updated',
  'specification.approved',
  'run.created',
  'run.pause_requested',
  'run.paused',
  'run.pause_rejected',
  'run.resume_requested',
  'run.resumed',
  'run.resume_rejected',
  'run.cancel_requested',
  'run.cancelled',
  'run.cancel_rejected',
  'run.redirect_requested',
  'run.redirected',
  'run.redirect_rejected',
  'workspace.create_requested',
  'workspace.created',
  'workspace.start_requested',
  'workspace.started',
  'workspace.start_rejected',
  'workspace.checkpoint_requested',
  'workspace.checkpointed',
  'workspace.checkpoint_rejected',
  'workspace.terminate_requested',
  'workspace.terminated',
  'workspace.terminate_rejected',
  'workspace.preview_requested',
  'workspace.previewed',
  'workspace.preview_rejected',
  'secret.created',
  'secret.rotated',
  'secret.deleted',
  'release.created',
  'release.approved',
  'release.deploy_requested',
  'release.rollback_requested',
  'integration.connected',
  /**
   * A secret value was decrypted (plan 02 CP-7). The one action in this list
   * that records a *read*, and the reason the internal decrypt route exists in
   * this shape at all: PRD §18.12 makes plaintext available to the sandbox
   * service at injection time, and an availability nobody can audit afterwards
   * is indistinguishable from an exfiltration. Written in the same transaction
   * as the read, so a decrypt that returned a value and left no row is not a
   * state this service can reach.
   */
  'secret.decrypted',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** PRD §23.6 `target_type`: the entity kind an action landed on. */
export type AuditTargetType =
  | 'organization'
  | 'membership'
  | 'invite'
  | 'project'
  | 'specification'
  | 'run'
  | 'workspace'
  | 'secret'
  | 'release'
  | 'integration_connection';

/** PRD §23.6 `actor_type`. Only `user` has a session behind it. */
export type AuditActorType = 'user' | 'service' | 'agent' | 'support';

/** What a metadata field may hold. Nothing that can nest. */
export type AuditScalar = string | number | boolean | null;

/**
 * One metadata value.
 *
 * Scalars, plus an array of them — a diff summary ("which fields moved") is the
 * one shape that genuinely needs a list, and a list of scalars still cannot
 * smuggle an object, a buffer or a whole request body into the table.
 */
export type AuditValue = AuditScalar | readonly AuditScalar[];

/**
 * Tenant-safe context: which role, which fields changed. Never a credential —
 * an invite token, a secret value and a session token are all things this table
 * would otherwise preserve for years.
 */
export type AuditMetadata = Readonly<Record<string, AuditValue>>;

/** One row of PRD §23.6 `audit_events`, minus the id the sink mints. */
export interface AuditRecord {
  readonly organizationId: string;
  readonly actorType: AuditActorType;
  readonly actorId: string;
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  /** Null for an action with no single target. */
  readonly targetId: string | null;
  readonly metadata: AuditMetadata;
  readonly occurredAt: Date;
}

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
  return {
    events,
    record(_tx, event) {
      events.push(event);
      return Promise.resolve();
    },
    recordDetached(event) {
      events.push(event);
      return Promise.resolve();
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
  async function insert(tx: Executor, event: AuditRecord): Promise<void> {
    await tx.insert(auditEvents).values({
      id: newId('aud'),
      organizationId: event.organizationId,
      actorType: event.actorType,
      actorId: event.actorId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      metadataJson: event.metadata,
      occurredAt: event.occurredAt,
    });
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
  };
}

/** What a route passes; everything else is filled in from the request. */
export interface AuditEntry {
  readonly organizationId: string;
  readonly action: AuditAction;
  readonly target: { readonly type: AuditTargetType; readonly id: string | null };
  readonly metadata?: AuditMetadata;
}

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

/**
 * Rejects anything that could carry more than it says it does.
 *
 * The types already say scalars; this is the second half of the same rule, for
 * the values that arrive from a database column or a JSON body and are typed
 * only by assertion. A throw here fails the mutation, which is the right
 * outcome: a row we cannot vouch for should not be written, and a metadata
 * object with something unexpected in it is a bug to fix, not to store.
 */
function assertScalars(metadata: AuditMetadata): void {
  const scalar = (value: unknown): boolean =>
    value === null || ['string', 'number', 'boolean'].includes(typeof value);

  for (const [field, value] of Object.entries(metadata)) {
    const ok = Array.isArray(value) ? value.every(scalar) : scalar(value);
    if (!ok) {
      throw new Error(`audit metadata field "${field}" is not a scalar`);
    }
  }
}

export const auditLog = fp<AuditLogOptions>(
  (app, options, done) => {
    const { sink, now } = options;

    function toRecord(
      actor: { readonly type: AuditActorType; readonly id: string },
      entry: AuditEntry,
    ): AuditRecord {
      const metadata = entry.metadata ?? {};
      assertScalars(metadata);

      return {
        organizationId: entry.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: entry.action,
        targetType: entry.target.type,
        targetId: entry.target.id,
        metadata,
        occurredAt: now(),
      };
    }

    function userActor(request: FastifyRequest): { type: AuditActorType; id: string } {
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

    function serviceActor(request: FastifyRequest): { type: AuditActorType; id: string } {
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
