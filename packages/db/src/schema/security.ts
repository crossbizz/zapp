import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

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
 *
 * "Elsewhere" is {@link secretCiphertexts}, and the split is the point: a
 * `select * from secret_metadata` cannot return ciphertext, so the read path the
 * API exposes (`GET /v1/projects/:projectId/secrets`, plan 02 CP-7) is
 * *structurally* metadata-only rather than metadata-only by review.
 */

export const secretMetadata = pgTable(
  'secret_metadata',
  {
    id: text('id').primaryKey(), // sec_*
    organizationId: organizationId(),
    /** Null for organization-wide secrets that no single project owns. */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
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
    /**
     * Which master-key generation wrapped this secret's DEK (plan 02 CP-7).
     *
     * Metadata, not key material: it names *which* key to unwrap with, which is
     * what an operator plans a re-encrypt sweep from and what makes rotating the
     * master key a background job rather than a schema change. Kept here rather
     * than on {@link secretCiphertexts} so the metadata read stays single-table
     * — see the module comment.
     *
     * Not a PRD §23.6 column; declared with its reason in
     * `packages/db/test/prd-schema-conformance.test.ts`, and last in the list
     * because that is where `ALTER TABLE ... ADD COLUMN` puts it.
     */
    keyVersion: integer('key_version').notNull(),
    /**
     * Also not a PRD §23.6 column: §23.6 lists `rotated_at` but no creation
     * time, and "when was this secret first set" is the other half of every
     * question the trail gets asked.
     */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('secret_metadata_org_project_idx').on(t.organizationId, t.projectId),
    /**
     * A name identifies a secret within one scope, so setting the same name
     * twice is a conflict rather than a second row nobody can tell apart.
     *
     * Two partial indexes rather than one, because Postgres treats NULLs as
     * distinct: a null `environment_id` means "every environment of this
     * project" (see the column), and under a single four-column unique index two
     * such rows would both be allowed. `NULLS NOT DISTINCT` would say it in one
     * index, and Drizzle cannot express it at this version — so it is said in
     * two, which the schema and the migration can both state.
     *
     * Both carry `project_id`, which is likewise nullable. Nothing in P0 creates
     * an organization-wide secret — every route is under
     * `/v1/projects/:projectId` — so that gap is unreachable rather than
     * unguarded; whoever adds one adds the third index with it.
     */
    uniqueIndex('secret_metadata_env_name_idx')
      .on(t.organizationId, t.projectId, t.environmentId, t.name)
      .where(sql`environment_id is not null`),
    uniqueIndex('secret_metadata_project_name_idx')
      .on(t.organizationId, t.projectId, t.name)
      .where(sql`environment_id is null`),
    projectTenantForeignKey('secret_metadata', t.projectId, t.organizationId),
  ],
);

/**
 * The vault: one row of envelope-encrypted key material per secret (PRD §18.12,
 * plan 02 CP-7).
 *
 * Separate from `secret_metadata` for the reason the module comment gives — the
 * metadata read cannot reach a ciphertext column that is not on the table it
 * selects from — and reached only through a `secret_metadata` row the caller's
 * organization already owns, exactly as `run_event_counters` is reached only
 * through a run. That is why it carries no `organization_id` of its own: a
 * denormalized tenant column here would be a second thing to keep in agreement
 * with the first, on a table whose only key is a secret id that was already
 * scoped.
 *
 * Every column is base64 of raw bytes, and the plaintext appears in none of
 * them:
 *
 *   - `ciphertext` — the value under AES-256-GCM with a per-secret data key.
 *   - `iv`, `auth_tag` — that encryption's 12-byte nonce and 16-byte tag.
 *   - `wrapped_dek` — the data key itself, encrypted under the master key named
 *     by `secret_metadata.key_version`. Self-framed (`iv || tag || ciphertext`)
 *     rather than three more columns: nothing but the unwrap ever reads it, so
 *     its framing is that function's business and not the schema's.
 *
 * P0 keeps no version history: a rotation overwrites this row in the same
 * transaction that bumps `secret_metadata.rotated_at`. Recovering a previous
 * value is deliberately impossible — a vault that can hand back the secret
 * somebody rotated *away from* has not really rotated it.
 */
export const secretCiphertexts = pgTable('secret_ciphertexts', {
  secretId: text('secret_id')
    .primaryKey()
    .references(() => secretMetadata.id, { onDelete: 'cascade' }),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  wrappedDek: text('wrapped_dek').notNull(),
});

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: text('id').primaryKey(), // intc_*
    organizationId: organizationId(),
    /** Null for an organization-level connection, e.g. a GitHub App installation (PRD §19.2). */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
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
    uniqueIndex('integration_connections_github_installation_idx')
      .on(
        t.organizationId,
        t.provider,
        sql`(${t.configurationJson} ->> 'installationId')`,
      )
      .where(sql`${t.provider} = 'github' and ${t.projectId} is null`),
    projectTenantForeignKey('integration_connections', t.projectId, t.organizationId),
  ],
);

/** Durable, signature-free receipt ledger for supported GitHub deliveries (INT-1). */
export const githubWebhookDeliveries = pgTable(
  'github_webhook_deliveries',
  {
    deliveryId: text('delivery_id').primaryKey(),
    eventName: text('event_name').notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    check('github_webhook_deliveries_status_check', sql`${t.status} in ('pending', 'published')`),
    index('github_webhook_deliveries_pending_idx').on(t.status, t.nextAttemptAt),
  ],
);

/** One durable, resumable GitHub import state machine per project (INT-2). */
export const githubImports = pgTable(
  'github_imports',
  {
    projectId: text('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: organizationId(),
    installationId: text('installation_id').notNull(),
    /** Non-secret external repository reference (`owner/name`). */
    repo: text('repo').notNull(),
    branch: text('branch').notNull(),
    operationKey: text('operation_key').notNull(),
    status: text('status').notNull(),
    externalRepoRef: text('external_repo_ref'),
    headCommitSha: text('head_commit_sha'),
    scanId: text('scan_id'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('github_imports_org_operation_key_idx').on(t.organizationId, t.operationKey),
    check(
      'github_imports_status_check',
      sql`${t.status} in ('queued', 'mirroring', 'scan_pending', 'scan_accepted', 'failed')`,
    ),
    check(
      'github_imports_error_code_check',
      sql`${t.errorCode} is null or ${t.errorCode} in ('github_unavailable', 'repository_not_found', 'branch_not_found', 'mirror_failed', 'scan_unavailable')`,
    ),
    projectTenantForeignKey('github_imports', t.projectId, t.organizationId),
  ],
);

/** Transactional, one-stage-per-delivery outbox for `zapp-github-imports`. */
export const githubImportOutbox = pgTable(
  'github_import_outbox',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => githubImports.projectId, { onDelete: 'cascade' }),
    stage: text('stage').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('github_import_outbox_project_stage_idx').on(t.projectId, t.stage),
    index('github_import_outbox_pending_idx').on(t.status, t.nextAttemptAt),
    check('github_import_outbox_stage_check', sql`${t.stage} in ('queued', 'scan_pending')`),
    check('github_import_outbox_status_check', sql`${t.status} in ('pending', 'published')`),
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
  (t) => [
    index('audit_events_org_occurred_at_idx').on(t.organizationId, t.occurredAt),
    index('audit_events_org_id_idx').on(t.organizationId, t.id),
    index('audit_events_org_actor_id_id_idx').on(t.organizationId, t.actorId, t.id),
    index('audit_events_org_action_id_idx').on(t.organizationId, t.action, t.id),
    index('audit_events_org_target_id_idx').on(t.organizationId, t.targetType, t.targetId, t.id),
  ],
);

export type SecretMetadata = typeof secretMetadata.$inferSelect;
export type NewSecretMetadata = typeof secretMetadata.$inferInsert;
export type SecretCiphertext = typeof secretCiphertexts.$inferSelect;
export type NewSecretCiphertext = typeof secretCiphertexts.$inferInsert;
export type IntegrationConnection = typeof integrationConnections.$inferSelect;
export type NewIntegrationConnection = typeof integrationConnections.$inferInsert;
export type GitHubWebhookDelivery = typeof githubWebhookDeliveries.$inferSelect;
export type NewGitHubWebhookDelivery = typeof githubWebhookDeliveries.$inferInsert;
export type GitHubImport = typeof githubImports.$inferSelect;
export type NewGitHubImport = typeof githubImports.$inferInsert;
export type GitHubImportOutboxEntry = typeof githubImportOutbox.$inferSelect;
export type NewGitHubImportOutboxEntry = typeof githubImportOutbox.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
