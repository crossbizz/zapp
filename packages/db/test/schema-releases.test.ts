import { describe, expect, it } from 'vitest';

import { deployments, releases, syntheticChecks } from '../src/schema/releases.js';
import { checkNames, columnNames, foreignKeys, indexNames } from './table-config.js';

/** PRD §23.5 pinned column by column; see `schema-projects.test.ts` for the convention. */
describe('release state (PRD §23.5)', () => {
  it('gives releases exactly the PRD columns, in order', () => {
    expect(columnNames(releases)).toEqual([
      'id',
      'organization_id',
      'project_id',
      'environment_id',
      'commit_sha',
      'specification_id',
      'status',
      'evidence_manifest_artifact_id',
      'created_by',
      'created_at',
    ]);
  });

  it('gives deployments exactly the PRD columns, in order', () => {
    expect(columnNames(deployments)).toEqual([
      'id',
      'organization_id',
      'release_id',
      'provider',
      'provider_deployment_id',
      'status',
      'url',
      'started_at',
      'completed_at',
      'rollback_of_deployment_id',
    ]);
  });

  it('gives synthetic_checks exactly the PRD columns, in order', () => {
    expect(columnNames(syntheticChecks)).toEqual([
      'id',
      'organization_id',
      'project_id',
      'environment_id',
      'name',
      'schedule',
      'status',
      'last_run_at',
    ]);
  });

  it('keeps a release pointing at its evidence and a rollback at what it undid', () => {
    expect(foreignKeys(releases)).toEqual([
      'organization_id -> organizations.id',
      'project_id -> projects.id',
      'environment_id -> environments.id',
      'specification_id -> specifications.id',
      // PRD §27.4: the evidence manifest is an artifact, so it is immutable and
      // citable rather than a blob on the release row.
      'evidence_manifest_artifact_id -> artifacts.id',
      'created_by -> users.id',
      'project_id, organization_id -> projects.id, organization_id',
    ]);
    expect(foreignKeys(deployments)).toEqual([
      'organization_id -> organizations.id',
      'release_id -> releases.id',
      // PRD §27.5: a rollback is a deployment that names the one it reverses,
      // which is what makes it auditable rather than just another deploy.
      'rollback_of_deployment_id -> deployments.id',
    ]);
    expect(foreignKeys(syntheticChecks)).toEqual([
      'organization_id -> organizations.id',
      'project_id -> projects.id',
      'environment_id -> environments.id',
      'project_id, organization_id -> projects.id, organization_id',
    ]);
  });

  it('indexes the release history and the deployment fan-out', () => {
    expect(indexNames(releases)).toEqual([
      'releases_project_created_at_idx',
      'releases_environment_idx',
    ]);
    expect(indexNames(deployments)).toEqual(['deployments_release_idx']);
    expect(indexNames(syntheticChecks)).toEqual(['synthetic_checks_project_environment_idx']);
  });

  it('leaves release and deployment status to plan 07', () => {
    // The provider's state machine is the provider's (`DeploymentStateSchema`),
    // and the release flow (PRD §27.3) is plan 07's to name.
    expect(checkNames(releases)).toEqual([]);
    expect(checkNames(deployments)).toEqual([]);
    expect(checkNames(syntheticChecks)).toEqual([]);
  });
});
