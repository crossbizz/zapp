import { describe, expect, it } from 'vitest';

import {
  branches,
  environments,
  projectContracts,
  projects,
  repositories,
} from '../src/schema/projects.js';
import {
  checkExpression,
  checkNames,
  columnNames,
  enumValues,
  foreignKeys,
  indexNames,
} from './table-config.js';

/**
 * PRD §23.2 pinned column by column. Database-free, so a rename fails in the
 * `test` job CI runs everywhere rather than only where Postgres exists.
 *
 * `organization_id` is the one column the PRD's conceptual list does not spell
 * out on every table; it sits directly after `id` by convention (plan 01 FND-6,
 * PRD §22.3), and `schema.test.ts` pins that rule across all 23 tables.
 */
describe('project state (PRD §23.2)', () => {
  it('gives projects exactly the PRD columns, in order', () => {
    expect(columnNames(projects)).toEqual([
      'id',
      'organization_id',
      'name',
      'slug',
      'description',
      'source_type',
      'support_level',
      'created_by',
      'created_at',
      'archived_at',
    ]);
  });

  it('gives repositories exactly the PRD columns, in order', () => {
    expect(columnNames(repositories)).toEqual([
      'id',
      'organization_id',
      'project_id',
      'provider',
      'internal_repo_ref',
      'external_repo_ref',
      'default_branch',
      'sync_policy',
    ]);
  });

  it('gives branches exactly the PRD columns, in order', () => {
    expect(columnNames(branches)).toEqual([
      'id',
      'organization_id',
      'project_id',
      'name',
      'head_commit_sha',
      'base_branch_id',
      'status',
    ]);
  });

  it('gives environments exactly the PRD columns, in order', () => {
    expect(columnNames(environments)).toEqual([
      'id',
      'organization_id',
      'project_id',
      'name',
      'type',
      'deployment_provider',
      'database_connection_id',
      'created_at',
    ]);
  });

  it('gives project_contracts exactly the PRD columns, in order', () => {
    expect(columnNames(projectContracts)).toEqual([
      'id',
      'organization_id',
      'project_id',
      'version',
      'detected_framework',
      'contract_json',
      'created_at',
    ]);
  });

  it('points every row at its parents, including the branch it was cut from', () => {
    expect(foreignKeys(projects)).toEqual([
      'organization_id -> organizations.id',
      'created_by -> users.id',
    ]);
    expect(foreignKeys(repositories)).toEqual([
      'organization_id -> organizations.id',
      'project_id -> projects.id',
      'project_id, organization_id -> projects.id, organization_id',
    ]);
    expect(foreignKeys(branches)).toEqual([
      'organization_id -> organizations.id',
      'project_id -> projects.id',
      'base_branch_id -> branches.id',
      'project_id, organization_id -> projects.id, organization_id',
    ]);
    expect(foreignKeys(environments)).toEqual([
      'organization_id -> organizations.id',
      'project_id -> projects.id',
      'project_id, organization_id -> projects.id, organization_id',
    ]);
    expect(foreignKeys(projectContracts)).toEqual([
      'organization_id -> organizations.id',
      'project_id -> projects.id',
      'project_id, organization_id -> projects.id, organization_id',
    ]);
  });

  it('makes the tenant-facing names unique where they are addressable', () => {
    // Slugs and branch/environment names appear in URLs and in git; they are
    // unique per owner, never globally — two tenants may both own "checkout".
    // projects_id_org_idx is the target of every composite tenant key.
    expect(indexNames(projects)).toEqual(['projects_org_slug_idx', 'projects_id_org_idx']);
    expect(indexNames(branches)).toEqual(['branches_project_name_idx']);
    expect(indexNames(environments)).toEqual(['environments_project_name_idx']);
    // Detection re-runs append a version rather than overwriting one (PRD §17.2).
    expect(indexNames(projectContracts)).toEqual(['project_contracts_project_version_idx']);
    expect(indexNames(repositories)).toEqual(['repositories_project_idx']);
  });

  it('constrains the support level to the PRD §7.1 tiers, in the database', () => {
    // Untyped literals on purpose: a tier dropped from the contracts enum and
    // from the column would otherwise pass unnoticed.
    expect(checkNames(projects)).toEqual(['projects_support_level_check']);
    expect(checkExpression(projects, 'projects_support_level_check')).toBe(
      "support_level in ('compatible', 'verified', 'managed')",
    );
    expect(enumValues(projects, 'support_level')).toEqual(['compatible', 'verified', 'managed']);
  });

  it('leaves the vocabularies the PRD does not fix unconstrained', () => {
    // source_type, sync_policy, environment type and branch status are plan 02
    // (CP-6) and plan 06's to define; a CHECK here would make their first
    // migration a rewrite.
    expect(checkNames(repositories)).toEqual([]);
    expect(checkNames(branches)).toEqual([]);
    expect(checkNames(environments)).toEqual([]);
    expect(checkNames(projectContracts)).toEqual([]);
  });
});
