import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { organizationId } from './columns.js';
import { users } from './identity.js';
import { environments, projectTenantForeignKey, projects } from './projects.js';

/**
 * PRD §23.6 — security and integrations. Columns follow PRD §23.6 in order;
 * these three tables already declare `organization_id` there, in the same
 * position `./columns.ts` puts it everywhere else.
 *
 * Nothing here stores a secret value: `secret_metadata` holds a *reference* to
 * ciphertext held elsewhere (PRD §18.12), and `integration_connections` holds a
 * credential reference, never the credential.
 */

export const secretMetadata = pgTable(
  'secret_metadata',
  {
    id: text('id').primaryKey(), // sec_*
    organizationId: organizationId(),
    /** Null for organization-wide secrets that no single project owns. */
    projectId: text('project_id').references(() => projects.id),
    /** Null when the secret applies to every environment of its project. */
    environmentId: text('environment_id').references(() => environments.id),
    name: text('name').notNull(),
    /**
     * Pointer into the vault (plan 02 CP-7). Never the plaintext, never the
     * ciphertext: reading a value is a separate, audited operation, and PRD
     * §22.2 gives nobody a UI path to it.
     */
    encryptedValueRef: text('encrypted_value_ref').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    /** Null until the secret has been rotated at least once. */
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (t) => [
    index('secret_metadata_org_project_idx').on(t.organizationId, t.projectId),
    projectTenantForeignKey('secret_metadata', t.projectId, t.organizationId),
  ],
);

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: text('id').primaryKey(), // intc_*
    organizationId: organizationId(),
    /** Null for an organization-level connection, e.g. a GitHub App installation (PRD §19.2). */
    projectId: text('project_id').references(() => projects.id),
    /** `github`, `supabase`, `neon`, `stripe`, … (PRD §25–26). */
    provider: text('provider').notNull(),
    status: text('status').notNull(),
    /** Vault reference, like `secret_metadata.encrypted_value_ref`; null before the OAuth handshake completes. */
    credentialRef: text('credential_ref'),
    /** Non-secret provider settings: account ids, project refs, chosen region. */
    configurationJson: jsonb('configuration_json').notNull(),
  },
  (t) => [
    index('integration_connections_org_project_idx').on(t.organizationId, t.projectId),
    projectTenantForeignKey('integration_connections', t.projectId, t.organizationId),
  ],
);

/**
 * PRD §23.6 audit log. Append-only (master plan §Global Constraints): this
 * package exports no update or delete helper for it, and plan 02 (CP-1) revokes
 * those grants from the application role. Plan 02 (CP-5) writes every row.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: text('id').primaryKey(), // aud_*
    organizationId: organizationId(),
    /** `user`, `service`, `agent`, `support` — which is why `actor_id` carries no foreign key. */
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    /** The affected entity, addressed by type and id rather than by a column per table. */
    targetType: text('target_type').notNull(),
    /** Null for actions with no single target (a bulk export, a failed login). */
    targetId: text('target_id'),
    metadataJson: jsonb('metadata_json').notNull(),
    /**
     * No default: an audit row records when the action happened, and a row
     * written by a retry or a backfill must not claim the time it was inserted.
     */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('audit_events_org_occurred_at_idx').on(t.organizationId, t.occurredAt)],
);

export type SecretMetadata = typeof secretMetadata.$inferSelect;
export type NewSecretMetadata = typeof secretMetadata.$inferInsert;
export type IntegrationConnection = typeof integrationConnections.$inferSelect;
export type NewIntegrationConnection = typeof integrationConnections.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
