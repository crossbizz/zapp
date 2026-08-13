import { describe, expect, it } from 'vitest';

import { artifactRetention, projectDeletions } from '../src/index.js';
import {
  checkNames,
  columnNames,
  enumValues,
  foreignKeys,
  indexNames,
  requiredColumns,
  tableName,
} from './table-config.js';

describe('CP-17 data lifecycle schema', () => {
  it('keeps deletion state after the project row is removed', () => {
    expect(tableName(projectDeletions)).toBe('project_deletions');
    expect(columnNames(projectDeletions)).toEqual([
      'project_id',
      'organization_id',
      'requested_by',
      'operation_key',
      'request_fingerprint',
      'status',
      'snapshots_status',
      'git_status',
      'objects_status',
      'postgres_status',
      'attempts',
      'next_attempt_at',
      'lease_owner',
      'lease_expires_at',
      'last_error_code',
      'requested_at',
      'updated_at',
      'completed_at',
    ]);
    expect(requiredColumns(projectDeletions)).not.toContain('completed_at');
    expect(foreignKeys(projectDeletions)).toEqual([
      'organization_id -> organizations.id',
      'requested_by -> users.id',
    ]);
    expect(indexNames(projectDeletions)).toEqual([
      'project_deletions_org_operation_idx',
      'project_deletions_poll_idx',
    ]);
    expect(checkNames(projectDeletions)).toEqual([
      'project_deletions_status_check',
      'project_deletions_targets_check',
      'project_deletions_lease_check',
      'project_deletions_completion_check',
    ]);
  });

  it('classifies only expirable artifacts and cannot classify release evidence', () => {
    expect(tableName(artifactRetention)).toBe('artifact_retention');
    expect(columnNames(artifactRetention)).toEqual([
      'artifact_id',
      'organization_id',
      'project_id',
      'retention_class',
      'expires_at',
    ]);
    expect(enumValues(artifactRetention, 'retention_class')).toEqual(['test', 'diagnostic']);
    expect(foreignKeys(artifactRetention)).toEqual([
      'artifact_id -> artifacts.id',
      'project_id, organization_id -> projects.id, organization_id',
    ]);
    expect(indexNames(artifactRetention)).toEqual(['artifact_retention_expiry_idx']);
  });
});
