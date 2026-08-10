import { describe, expect, it } from 'vitest';

import {
  activityIdempotency,
  agentEvents,
  artifacts,
  MAX_EVENT_PAYLOAD_BYTES,
  testCases,
  testRuns,
  verificationResults,
  workspaces,
} from '../src/schema/execution.js';
import {
  checkExpression,
  checkNames,
  columnNames,
  enumValues,
  foreignKeys,
  indexNames,
  primaryKeyColumns,
  sqlType,
} from './table-config.js';

/** PRD §23.4 pinned column by column; see `schema-projects.test.ts` for the convention. */
describe('execution and evidence (PRD §23.4)', () => {
  it('gives workspaces the PRD columns plus durable WS-13 runtime state, in order', () => {
    expect(columnNames(workspaces)).toEqual([
      'id',
      'organization_id',
      'project_id',
      'branch_id',
      'provider',
      'provider_workspace_id',
      'status',
      'resource_profile',
      'run_id',
      'task_id',
      'purpose',
      'environment',
      'image_tag',
      'preview_monitor_enabled',
      'preview_monitor_owner_id',
      'preview_monitor_lease_expires_at',
      'snapshot_ref',
      'created_at',
      'last_active_at',
      'terminated_at',
    ]);
  });

  it('gives agent_events the PRD columns plus CP-13 replay context, in order', () => {
    expect(columnNames(agentEvents)).toEqual([
      'id',
      'organization_id',
      'run_id',
      'sequence',
      'type',
      'payload_json',
      'visibility',
      'occurred_at',
      // CP-13 persists the complete PRD §14.4 event replay shape.
      'project_id',
      'phase_id',
      'task_id',
      'agent_id',
    ]);
  });

  it('gives artifacts exactly the PRD columns, in order', () => {
    expect(columnNames(artifacts)).toEqual([
      'id',
      'organization_id',
      'project_id',
      'run_id',
      'task_id',
      'type',
      'storage_ref',
      'content_hash',
      'metadata_json',
      'created_at',
    ]);
  });

  it('gives test_runs exactly the PRD columns, in order', () => {
    expect(columnNames(testRuns)).toEqual([
      'id',
      'organization_id',
      'run_id',
      'task_id',
      'commit_sha',
      'type',
      'status',
      'started_at',
      'completed_at',
      'summary_json',
    ]);
  });

  it('gives test_cases exactly the PRD columns, in order', () => {
    expect(columnNames(testCases)).toEqual([
      'id',
      'organization_id',
      'test_run_id',
      'name',
      'status',
      'duration_ms',
      'evidence_artifact_id',
      'error_json',
    ]);
  });

  it('gives verification_results exactly the PRD columns, in order', () => {
    expect(columnNames(verificationResults)).toEqual([
      'id',
      'organization_id',
      'run_id',
      'task_id',
      'commit_sha',
      'decision',
      'criteria_results_json',
      'risks_json',
      'created_at',
    ]);
  });

  it('keeps the evidence chain joinable', () => {
    expect(foreignKeys(workspaces)).toEqual([
      'organization_id -> organizations.id',
      'project_id -> projects.id',
      'branch_id -> branches.id',
      'project_id, organization_id -> projects.id, organization_id',
    ]);
    expect(foreignKeys(artifacts)).toEqual([
      'organization_id -> organizations.id',
      'project_id -> projects.id',
      'run_id -> agent_runs.id',
      'task_id -> agent_tasks.id',
      'project_id, organization_id -> projects.id, organization_id',
    ]);
    expect(foreignKeys(testRuns)).toEqual([
      'organization_id -> organizations.id',
      'run_id -> agent_runs.id',
      'task_id -> agent_tasks.id',
    ]);
    // A failing case points at the screenshot or trace that proves it (PRD §24.4).
    expect(foreignKeys(testCases)).toEqual([
      'organization_id -> organizations.id',
      'test_run_id -> test_runs.id',
      'evidence_artifact_id -> artifacts.id',
    ]);
    expect(foreignKeys(verificationResults)).toEqual([
      'organization_id -> organizations.id',
      'run_id -> agent_runs.id',
      'task_id -> agent_tasks.id',
    ]);
  });

  it('indexes the reaper, the timeline and the evidence lookups', () => {
    expect(indexNames(workspaces)).toEqual([
      'workspaces_org_status_idx',
      'workspaces_project_idx',
      'workspaces_preview_monitor_idx',
    ]);
    expect(indexNames(artifacts)).toEqual([
      'artifacts_project_created_at_idx',
      'artifacts_run_idx',
      'artifacts_capability_scan_operation_idx',
    ]);
    expect(indexNames(testRuns)).toEqual(['test_runs_run_idx']);
    expect(indexNames(testCases)).toEqual(['test_cases_test_run_idx']);
    expect(indexNames(verificationResults)).toEqual(['verification_results_run_idx']);
  });

  it('constrains the workspace lifecycle to PRD §18.9, in the database', () => {
    expect(checkNames(workspaces)).toEqual([
      'workspaces_status_check',
      'workspaces_attachment_complete_check',
      'workspaces_preview_monitor_lease_check',
      'workspaces_preview_monitor_disabled_check',
    ]);
    expect(checkExpression(workspaces, 'workspaces_status_check')).toBe(
      "status in ('requested', 'provisioning', 'started', 'ready', 'active', 'checkpointing', 'idle', 'terminated')",
    );
    expect(enumValues(workspaces, 'status')).toEqual([
      'requested',
      'provisioning',
      'started',
      'ready',
      'active',
      'checkpointing',
      'idle',
      'terminated',
    ]);
  });
});

describe('agent_events', () => {
  it('is keyed by (id, occurred_at) so the partition key is part of the key', () => {
    // Postgres requires the partition key in every unique constraint on a
    // partitioned table; the hand-written migration is what makes it one.
    expect(primaryKeyColumns(agentEvents)).toEqual(['id', 'occurred_at']);
  });

  it('scopes, binds replay relations, and time-bounds the tenant read (master plan §5.2)', () => {
    expect(indexNames(agentEvents)).toEqual(['agent_events_org_occurred_at_idx']);
    expect(foreignKeys(agentEvents)).toEqual([
      'organization_id -> organizations.id',
      'run_id -> agent_runs.id',
      'project_id -> projects.id',
      'phase_id -> agent_phases.id',
      'task_id -> agent_tasks.id',
      'project_id, organization_id -> projects.id, organization_id',
    ]);
  });

  it('caps the payload at 64 KiB and the visibility at the PRD §14.4 set', () => {
    expect(MAX_EVENT_PAYLOAD_BYTES).toBe(65_536);
    expect(checkNames(agentEvents)).toEqual([
      'agent_events_visibility_check',
      'agent_events_payload_size_check',
    ]);
    expect(checkExpression(agentEvents, 'agent_events_payload_size_check')).toBe(
      'pg_column_size(payload_json) <= 65536',
    );
    expect(checkExpression(agentEvents, 'agent_events_visibility_check')).toBe(
      "visibility in ('user', 'internal', 'support')",
    );
    expect(enumValues(agentEvents, 'visibility')).toEqual(['user', 'internal', 'support']);
  });

  it('types the event by the PRD §14.4 list and the sequence as a number', () => {
    // 34 types, and the column refuses anything outside them at compile time.
    expect(enumValues(agentEvents, 'type')).toHaveLength(34);
    expect(enumValues(agentEvents, 'type').slice(0, 3)).toEqual([
      'run.created',
      'run.started',
      'run.paused',
    ]);
    // bigint: a busy run outliving int4 is a wrap-around, not an error.
    expect(sqlType(agentEvents, 'sequence')).toBe('bigint');
    expect(sqlType(agentEvents, 'payload_json')).toBe('jsonb');
    expect(sqlType(agentEvents, 'occurred_at')).toBe('timestamp with time zone');
  });
});

describe('activity_idempotency (AR-9)', () => {
  it('pins the durable claim, lease, hash, and replay columns', () => {
    expect(columnNames(activityIdempotency)).toEqual([
      'idempotency_key',
      'activity_type',
      'input_hash',
      'status',
      'owner_id',
      'lease_expires_at',
      'result_hash',
      'result_json',
      'created_at',
      'updated_at',
    ]);
    expect(enumValues(activityIdempotency, 'status')).toEqual(['running', 'completed']);
    expect(checkNames(activityIdempotency)).toEqual([
      'activity_idempotency_input_hash_check',
      'activity_idempotency_result_hash_check',
      'activity_idempotency_state_check',
    ]);
    expect(indexNames(activityIdempotency)).toEqual(['activity_idempotency_lease_idx']);
  });
});
