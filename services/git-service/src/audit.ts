import { SERVICE_NAMES } from '@zapp/config';
import { AuditRecordSchema, InternalRepoRefSchema, idSchema, newId } from '@zapp/contracts';
import { auditEvents, type Executor } from '@zapp/db';
import { z } from 'zod';

import {
  EPHEMERAL_USERNAME_PATTERN,
  MAX_TOKEN_TTL_SECONDS,
  TOKEN_ACCESS_LEVELS,
} from './tokens.js';

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
 * owns the HTTP read surface, while `@zapp/contracts` owns the platform action
 * vocabulary and row boundaries every writer and reader shares. This service
 * appends directly, with `actor_type = 'service'` and `actor_id` naming the
 * caller, then the control plane reads the same row through the same schemas.
 * Keeping the write local also avoids a network hop between issuing a credential
 * and recording who received it.
 *
 * **Never the token.** {@link GitAuditEvent} has no field one fits in, which is
 * the only reliable way to keep it out: the ephemeral username is recorded (so a
 * Forgejo access log line can be tied back to a request) and the secret is not.
 */

export { GIT_AUDIT_ACTIONS, GitAuditActionSchema, type GitAuditAction } from '@zapp/contracts';

const GitAuditReasonSchema = z.string().trim().min(8).max(500);

/** The reviewed non-secret context for one issued repository credential. */
export const GitTokenMintedAuditMetadataSchema = z
  .object({
    internalRepoRef: InternalRepoRefSchema,
    access: z.enum(TOKEN_ACCESS_LEVELS),
    ttlSec: z.number().int().positive().max(MAX_TOKEN_TTL_SECONDS),
    expiresAt: z.string().datetime({ offset: true }),
    tokenUser: z.string().regex(EPHEMERAL_USERNAME_PATTERN, 'Invalid ephemeral Git username'),
    reason: GitAuditReasonSchema,
    runId: idSchema('run').nullable(),
    taskId: idSchema('task').nullable(),
  })
  .strict();
export type GitTokenMintedAuditMetadata = z.infer<typeof GitTokenMintedAuditMetadataSchema>;

/** The reviewed non-secret context for repository credential revocation. */
export const GitTokenRevokedAuditMetadataSchema = z
  .object({
    internalRepoRef: InternalRepoRefSchema,
    revoked: z.number().int().positive(),
    reason: GitAuditReasonSchema,
  })
  .strict();
export type GitTokenRevokedAuditMetadata = z.infer<typeof GitTokenRevokedAuditMetadataSchema>;

const GitAuditEventBaseSchema = z
  .object({
    organizationId: idSchema('org'),
    /** The project the credential was for. `audit_events.target_id`. */
    projectId: idSchema('proj'),
    /** Which service asked. From the verified token, never from a request body. */
    requestingService: z.enum(SERVICE_NAMES),
    occurredAt: z.date(),
  })
  .strict();

export const GitTokenMintedAuditEventSchema = GitAuditEventBaseSchema.extend({
  action: z.literal('git_token.minted'),
  metadata: GitTokenMintedAuditMetadataSchema,
}).strict();
export type GitTokenMintedAuditEvent = z.infer<typeof GitTokenMintedAuditEventSchema>;

export const GitTokenRevokedAuditEventSchema = GitAuditEventBaseSchema.extend({
  action: z.literal('git_token.revoked'),
  metadata: GitTokenRevokedAuditMetadataSchema,
}).strict();
export type GitTokenRevokedAuditEvent = z.infer<typeof GitTokenRevokedAuditEventSchema>;

/** The service-specific input before it becomes one shared platform audit row. */
export const GitAuditEventSchema = z.discriminatedUnion('action', [
  GitTokenMintedAuditEventSchema,
  GitTokenRevokedAuditEventSchema,
]);
export type GitAuditEvent = z.infer<typeof GitAuditEventSchema>;

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
      const parsed = GitAuditEventSchema.parse(event);
      const record = AuditRecordSchema.parse({
        organizationId: parsed.organizationId,
        actorType: 'service',
        actorId: parsed.requestingService,
        action: parsed.action,
        targetType: 'project',
        targetId: parsed.projectId,
        metadata: parsed.metadata,
        occurredAt: parsed.occurredAt,
      });
      await db.insert(auditEvents).values({
        id: newId('aud'),
        organizationId: record.organizationId,
        // Not `user`: no person is on the other end of this, and filing it as one
        // would put a service's action into a person's history.
        actorType: record.actorType,
        actorId: record.actorId,
        action: record.action,
        targetType: record.targetType,
        targetId: record.targetId,
        metadataJson: record.metadata,
        occurredAt: record.occurredAt,
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
      return Promise.resolve().then(() => {
        events.push(GitAuditEventSchema.parse(event));
      });
    },
  };
}
