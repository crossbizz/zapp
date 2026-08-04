import { describe, expect, it } from 'vitest';

import {
  auditEvents,
  integrationConnections,
  secretCiphertexts,
  secretMetadata,
} from '../src/schema/security.js';
import {
  columnNames,
  foreignKeys,
  indexNames,
  primaryKeyColumns,
  requiredColumns,
  sqlType,
} from './table-config.js';

/** PRD §23.6 pinned column by column; see `schema-projects.test.ts` for the convention. */
describe('security and integrations (PRD §23.6)', () => {
  it('gives secret_metadata exactly the PRD columns, in order', () => {
    expect(columnNames(secretMetadata)).toEqual([
      'id',
      'organization_id',
      'project_id',
      'environment_id',
      'name',
      'encrypted_value_ref',
      'created_by',
      'rotated_at',
      // Not PRD columns: which master key wrapped the secret's data key, and
      // when the secret was first set (plan 02 CP-7). Both are declared with
      // their reasons in prd-schema-conformance.test.ts, and last in the list
      // because that is where ALTER TABLE ... ADD COLUMN puts them.
      'key_version',
      'created_at',
    ]);
  });

  it('gives integration_connections exactly the PRD columns, in order', () => {
    expect(columnNames(integrationConnections)).toEqual([
      'id',
      'organization_id',
      'project_id',
      'provider',
      'status',
      'credential_ref',
      'configuration_json',
    ]);
  });

  it('gives audit_events exactly the PRD columns, in order', () => {
    expect(columnNames(auditEvents)).toEqual([
      'id',
      'organization_id',
      'actor_type',
      'actor_id',
      'action',
      'target_type',
      'target_id',
      'metadata_json',
      'occurred_at',
    ]);
  });

  it('stores references to secrets, never secrets', () => {
    // The names say it and the types back it: both are `text` pointers into the
    // vault (plan 02 CP-7), and neither table has a value column to leak.
    expect(sqlType(secretMetadata, 'encrypted_value_ref')).toBe('text');
    expect(sqlType(integrationConnections, 'credential_ref')).toBe('text');
    expect(columnNames(secretMetadata)).not.toContain('value');
    expect(columnNames(integrationConnections)).not.toContain('credential');
    // The whole point of the split (plan 02 CP-7): the ciphertext lives on
    // another table, so the metadata read has no column to leak even by
    // accident. A `ciphertext` on `secret_metadata` would make every
    // `select *` in this service one review away from serving a secret.
    for (const column of ['ciphertext', 'iv', 'auth_tag', 'wrapped_dek']) {
      expect(columnNames(secretMetadata)).not.toContain(column);
    }
  });

  it('keeps the vault keyed by the secret it belongs to, and nothing else', () => {
    expect(columnNames(secretCiphertexts)).toEqual([
      'secret_id',
      'ciphertext',
      'iv',
      'auth_tag',
      'wrapped_dek',
    ]);
    expect(primaryKeyColumns(secretCiphertexts)).toEqual([]);
    expect(sqlType(secretCiphertexts, 'secret_id')).toBe('text');
    // No `organization_id`, deliberately (see the schema comment): the row is
    // reachable only through a `secret_metadata` row a tenant-scoped query
    // returned, exactly as run_event_counters is reachable only through a run.
    expect(columnNames(secretCiphertexts)).not.toContain('organization_id');
    expect(foreignKeys(secretCiphertexts)).toEqual(['secret_id -> secret_metadata.id']);
    // Every column carries key material or is the key it belongs to, so all of
    // them are required — a half-written envelope is not decryptable.
    expect(requiredColumns(secretCiphertexts)).toEqual([
      'secret_id',
      'ciphertext',
      'iv',
      'auth_tag',
      'wrapped_dek',
    ]);
  });

  it('scopes secrets and connections to a tenant, optionally to a project', () => {
    expect(foreignKeys(secretMetadata)).toEqual([
      'organization_id -> organizations.id',
      'project_id -> projects.id',
      'environment_id -> environments.id',
      'created_by -> users.id',
      'project_id, organization_id -> projects.id, organization_id',
    ]);
    expect(foreignKeys(integrationConnections)).toEqual([
      'organization_id -> organizations.id',
      'project_id -> projects.id',
      'project_id, organization_id -> projects.id, organization_id',
    ]);
    // Organization-level secrets and installations exist, so these are nullable.
    expect(requiredColumns(secretMetadata)).not.toContain('project_id');
    expect(requiredColumns(integrationConnections)).not.toContain('project_id');
    expect(indexNames(secretMetadata)).toEqual([
      'secret_metadata_org_project_idx',
      // A name is unique within its scope, in two partial indexes rather than
      // one — Postgres treats NULLs as distinct, and a null environment means
      // "every environment" (plan 02 CP-7).
      'secret_metadata_env_name_idx',
      'secret_metadata_project_name_idx',
    ]);
    expect(indexNames(integrationConnections)).toEqual(['integration_connections_org_project_idx']);
  });

  it('keeps the audit actor polymorphic and the log time-ordered', () => {
    // Actors are users, services, agents and support staff, so `actor_id`
    // carries no foreign key — the type column says how to read it.
    expect(foreignKeys(auditEvents)).toEqual(['organization_id -> organizations.id']);
    expect(requiredColumns(auditEvents)).toContain('actor_type');
    expect(requiredColumns(auditEvents)).toContain('actor_id');
    expect(indexNames(auditEvents)).toEqual(['audit_events_org_occurred_at_idx']);
    // No default on occurred_at: a backfilled or retried row must not claim the
    // time it was inserted (same rule as usage_ledger).
    expect(sqlType(auditEvents, 'occurred_at')).toBe('timestamp with time zone');
  });
});
