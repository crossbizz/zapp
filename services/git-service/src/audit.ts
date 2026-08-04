import type { ServiceName } from '@zapp/config';
import { newId } from '@zapp/contracts';
import { auditEvents, type Executor } from '@zapp/db';

/**
 * The audit trail for repository credentials (plan 06 GIT-3).
 *
 * PRD §19.1 requires audit logs from the internal Git service, and the thing
 * worth auditing is not "a repository was read" — Forgejo logs that — but **who
 * was handed the ability to**. A repository-scoped token is a credential this
 * service manufactures out of its own admin reach, and a credential nobody can
 * account for afterwards is indistinguishable from an exfiltration. That is the
 * same argument CP-7 makes for `secret.decrypted`, and these rows sit in the
 * same table for the same reason: one trail, one place to look during an
 * incident.
 *
 * **Where this sits relative to the control plane, and why.** The control plane
 * owns the *audit surface* — the vocabulary its own routes write, and any API
 * over `audit_events` — but `audit_events` itself is PRD §23.6's platform-wide
 * append-only ledger rather than one service's table. This service appends its
 * own rows directly, with `actor_type = 'service'` and `actor_id` naming the
 * caller, which is the exact shape `request.auditService` writes in the control
 * plane (`services/control-api/src/plugins/audit.ts`).
 *
 * The alternative was for this service to POST its audit rows to a new internal
 * route on the control plane. That is arguably the tidier ownership story, and it
 * was rejected on cost: it needs a new service-token audience, a new internal
 * route, and an addition to the control plane's `AUDIT_ACTIONS` — three files
 * this task does not own — and it buys a network hop between an action and the
 * record of it, which is a hop in which the record can be lost. Worth revisiting
 * when a second service needs to write a row; recorded here so the decision is
 * visible rather than assumed.
 *
 * **Never the token.** {@link GitAuditEvent} has no field one fits in, which is
 * the only reliable way to keep it out: the ephemeral username is recorded (so a
 * Forgejo access log line can be tied back to a request) and the secret is not.
 */

/**
 * Actions this service records. A closed set, so a typo cannot invent a new
 * vocabulary term that a compliance query will then silently miss.
 */
export const GIT_AUDIT_ACTIONS = ['git_token.minted', 'git_token.revoked'] as const;

export type GitAuditAction = (typeof GIT_AUDIT_ACTIONS)[number];

/** Scalars only, for the reason the control plane's metadata is scalars only. */
export type AuditValue = string | number | boolean | null;

export interface GitAuditEvent {
  readonly organizationId: string;
  readonly action: GitAuditAction;
  /** The project the credential was for. `audit_events.target_id`. */
  readonly projectId: string;
  /** Which service asked. From the verified token, never from a request body. */
  readonly requestingService: ServiceName;
  readonly occurredAt: Date;
  readonly metadata: Readonly<Record<string, AuditValue>>;
}

export interface GitAuditSink {
  /** @throws when the row cannot be written — see `src/tokens.ts` for what the caller then does. */
  record(event: GitAuditEvent): Promise<void>;
}

/**
 * The shipping sink: one `audit_events` insert.
 *
 * `audit_events` is append-only and the migration enforces it with a trigger
 * (`packages/db/drizzle/0003`, `0006`), so there is deliberately no update and no
 * delete here — a correction is another row, never an edit.
 */
export function createDbGitAuditSink(db: Executor): GitAuditSink {
  return {
    async record(event) {
      await db.insert(auditEvents).values({
        id: newId('aud'),
        organizationId: event.organizationId,
        // Not `user`: no person is on the other end of this, and filing it as one
        // would put a service's action into a person's history.
        actorType: 'service',
        actorId: event.requestingService,
        action: event.action,
        targetType: 'project',
        targetId: event.projectId,
        metadataJson: event.metadata,
        occurredAt: event.occurredAt,
      });
    },
  };
}

export interface RecordingGitAuditSink extends GitAuditSink {
  readonly events: readonly GitAuditEvent[];
  /** Makes the next `record` throw, so the caller's compensation can be exercised. */
  failNext(error: Error): void;
}

/**
 * Keeps the trail in memory. For tests, and for nothing else: an audit trail a
 * restart erases is not an audit trail.
 */
export function createRecordingGitAuditSink(): RecordingGitAuditSink {
  const events: GitAuditEvent[] = [];
  let failure: Error | undefined;
  return {
    events,
    failNext(error) {
      failure = error;
    },
    record(event) {
      if (failure !== undefined) {
        const thrown = failure;
        failure = undefined;
        return Promise.reject(thrown);
      }
      events.push(event);
      return Promise.resolve();
    },
  };
}
