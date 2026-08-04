import { describe, expect, it } from 'vitest';

import { auditEvents, integrationConnections, secretMetadata } from '../src/schema/security.js';
import { columnNames, foreignKeys, indexNames, requiredColumns, sqlType } from './table-config.js';

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
  });

  it('scopes secrets and connections to a tenant, optionally to a project', () => {
    expect(foreignKeys(secretMetadata)).toEqual([
      'organization_id -> organizations.id',
      'project_id -> projects.id',
      'environment_id -> environments.id',
      'created_by -> users.id',
    ]);
    expect(foreignKeys(integrationConnections)).toEqual([
      'organization_id -> organizations.id',
      'project_id -> projects.id',
    ]);
    // Organization-level secrets and installations exist, so these are nullable.
    expect(requiredColumns(secretMetadata)).not.toContain('project_id');
    expect(requiredColumns(integrationConnections)).not.toContain('project_id');
    expect(indexNames(secretMetadata)).toEqual(['secret_metadata_org_project_idx']);
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
