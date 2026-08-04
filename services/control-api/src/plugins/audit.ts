import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * The audit trail's call sites.
 *
 * Master plan §Global Constraints and PRD §22.3 require every mutating route to
 * record what was done, by whom, to what. The *row* — an `audit_events` insert
 * in the same transaction as the mutation — belongs to CP-5, which owns the
 * database-backed sink and the transaction plumbing. What belongs here, now, is
 * the seam: the routes that mutate memberships and organizations call
 * `request.audit(...)` today, so CP-5 wires an implementation in rather than
 * hunting for the places that should have called one.
 *
 * The actor is taken from the session rather than from the caller's arguments.
 * A handler cannot claim an audit row was somebody else's doing, which is the
 * one property that makes the trail worth keeping.
 *
 * CP-4 folds this into the request context (`ctx.audit(...)`) alongside
 * `ctx.db` and `ctx.organizationId`; until that exists, `organizationId` is
 * passed explicitly because an audit row is always tenant-scoped.
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
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** PRD §23.6 `target_type`: the entity kind an action landed on. */
export type AuditTargetType = 'organization' | 'membership' | 'invite';

/** PRD §23.6 `actor_type`. Only `user` has a session behind it. */
export type AuditActorType = 'user' | 'service' | 'agent' | 'support';

/** One row of PRD §23.6 `audit_events`, minus the id the sink mints. */
export interface AuditRecord {
  readonly organizationId: string;
  readonly actorType: AuditActorType;
  readonly actorId: string;
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  /** Null for an action with no single target. */
  readonly targetId: string | null;
  /**
   * Tenant-safe context: which role, which fields changed. Never a credential —
   * an invite token, a secret value and a session token are all things this
   * table would otherwise preserve for years.
   */
  readonly metadata: Record<string, unknown>;
  readonly occurredAt: Date;
}

export interface AuditSink {
  record(event: AuditRecord): Promise<void>;
}

export interface InMemoryAuditSink extends AuditSink {
  readonly events: readonly AuditRecord[];
}

/**
 * Keeps the trail in memory. Correct for tests and for a single-process
 * development run, and for nothing else — an audit trail that a restart erases
 * is not an audit trail, which is why `buildApp` refuses to default to this in
 * production.
 */
export function createInMemoryAuditSink(): InMemoryAuditSink {
  const events: AuditRecord[] = [];
  return {
    events,
    record(event) {
      events.push(event);
      return Promise.resolve();
    },
  };
}

/** What a route passes; everything else is filled in from the request. */
export interface AuditEntry {
  readonly organizationId: string;
  readonly action: AuditAction;
  readonly target: { readonly type: AuditTargetType; readonly id: string | null };
  readonly metadata?: Record<string, unknown>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Records one audit entry for the authenticated actor. Requires a session. */
    audit(entry: AuditEntry): Promise<void>;
  }
}

export interface AuditLogOptions {
  readonly sink: AuditSink;
  readonly now: () => Date;
}

export const auditLog = fp<AuditLogOptions>(
  (app, options, done) => {
    const { sink, now } = options;

    app.decorateRequest(
      'audit',
      function audit(this: FastifyRequest, entry: AuditEntry): Promise<void> {
        const auth = this.auth;
        if (auth === undefined) {
          // Not reachable from a route with `requireSession`, which is all of
          // them. Reaching it means a mutating route was registered without
          // one, and a 500 is the honest outcome: the alternative is an audit
          // row that names no actor.
          throw new Error('audit requires an authenticated request');
        }

        return sink.record({
          organizationId: entry.organizationId,
          actorType: 'user',
          actorId: auth.userId,
          action: entry.action,
          targetType: entry.target.type,
          targetId: entry.target.id,
          metadata: entry.metadata ?? {},
          occurredAt: now(),
        });
      },
    );

    done();
  },
  { name: 'audit-log', fastify: '5.x' },
);
