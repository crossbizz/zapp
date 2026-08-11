import { z } from 'zod';

import { idSchema } from './ids.js';

/** Git-service's reviewed subset of the platform audit action vocabulary. */
export const GIT_AUDIT_ACTIONS = ['git_token.minted', 'git_token.revoked'] as const;
export const GitAuditActionSchema = z.enum(GIT_AUDIT_ACTIONS);
export type GitAuditAction = z.infer<typeof GitAuditActionSchema>;

/**
 * Every action any zapp service may persist to PRD §23.6 `audit_events`.
 *
 * One platform tuple keeps writers and readers in lockstep. A service-specific
 * schema may narrow this list, but no writer owns a parallel vocabulary that a
 * platform reader can reject.
 */
export const AUDIT_ACTIONS = [
  'organization.created',
  'organization.updated',
  'organization.settings_updated',
  'member.invited',
  'member.joined',
  'member.role_changed',
  'member.removed',
  'project.created',
  'project.updated',
  'project.scan_requested',
  'specification.created',
  'specification.updated',
  'specification.approved',
  'run.created',
  'run.dispatch_failed',
  'run.dispatch_retried',
  'run.message_created',
  'run.events_ingested',
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
  'run.approval_resolved',
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
  'attachment.created',
  'release.created',
  'release.approved',
  'release.deploy_requested',
  'release.rollback_requested',
  'integration.connected',
  'secret.decrypted',
  ...GIT_AUDIT_ACTIONS,
] as const;

export const AuditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditActionSchema>;

/** PRD §23.6 `target_type`: the entity kind an action landed on. */
export const AUDIT_TARGET_TYPES = [
  'organization',
  'membership',
  'invite',
  'project',
  'specification',
  'run',
  'workspace',
  'artifact',
  'secret',
  'release',
  'integration_connection',
] as const;
export const AuditTargetTypeSchema = z.enum(AUDIT_TARGET_TYPES);
export type AuditTargetType = z.infer<typeof AuditTargetTypeSchema>;

/** PRD §23.6 `actor_type`. Only `user` has a session behind it. */
export const AUDIT_ACTOR_TYPES = ['user', 'service', 'agent', 'support'] as const;
export const AuditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

/** What a metadata field may hold. Nothing that can nest. */
export const AuditScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type AuditScalar = z.infer<typeof AuditScalarSchema>;

/** Scalars plus flat scalar arrays, never nested request or credential objects. */
export const AuditValueSchema = z.union([AuditScalarSchema, z.array(AuditScalarSchema)]);
export type AuditValue = z.infer<typeof AuditValueSchema>;

/** Tenant-safe context attached to one platform audit row. */
export const AuditMetadataSchema = z.record(AuditValueSchema);
export type AuditMetadata = z.infer<typeof AuditMetadataSchema>;

export const AuditActorSchema = z
  .object({ type: AuditActorTypeSchema, id: z.string().min(1) })
  .strict();
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AuditTargetSchema = z
  .object({ type: AuditTargetTypeSchema, id: z.string().nullable() })
  .strict();
export type AuditTarget = z.infer<typeof AuditTargetSchema>;

/** One writable PRD §23.6 `audit_events` row, minus the id the sink mints. */
export const AuditRecordSchema = z
  .object({
    organizationId: idSchema('org'),
    actorType: AuditActorTypeSchema,
    actorId: z.string().min(1),
    action: AuditActionSchema,
    targetType: AuditTargetTypeSchema,
    targetId: z.string().nullable(),
    metadata: AuditMetadataSchema,
    occurredAt: z.date(),
  })
  .strict();
export type AuditRecord = z.infer<typeof AuditRecordSchema>;
