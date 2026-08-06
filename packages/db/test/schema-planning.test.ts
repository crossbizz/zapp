import { describe, expect, it } from 'vitest';

import {
  agentPhases,
  agentRuns,
  agentTasks,
  approvals,
  decisions,
  specifications,
} from '../src/schema/planning.js';
import {
  checkExpression,
  checkNames,
  columnNames,
  enumValues,
  foreignKeys,
  indexNames,
} from './table-config.js';

/** PRD §23.3 pinned column by column; see `schema-projects.test.ts` for the convention. */
describe('specification and planning (PRD §23.3)', () => {
  it('gives specifications exactly the PRD columns, in order', () => {
    expect(columnNames(specifications)).toEqual([
      'id',
      'organization_id',
      'project_id',
      'version',
      'status',
      'content_json',
      'created_by',
      'approved_by',
      'approved_at',
    ]);
  });

  it('gives decisions exactly the PRD columns, in order', () => {
    expect(columnNames(decisions)).toEqual([
      'id',
      'organization_id',
      'project_id',
      'specification_id',
      'question',
      'decision',
      'rationale',
      'made_by',
      'created_at',
    ]);
  });

  it('gives agent_runs exactly the PRD columns, in order', () => {
    expect(columnNames(agentRuns)).toEqual([
      'id',
      'organization_id',
      'project_id',
      'branch_id',
      'mode',
      'app_type',
      'model',
      'request_fingerprint',
      'status',
      'specification_id',
      'temporal_workflow_id',
      'started_by',
      'budget_json',
      'started_at',
      'completed_at',
    ]);
  });

  it('gives agent_phases exactly the PRD columns, in order', () => {
    expect(columnNames(agentPhases)).toEqual([
      'id',
      'organization_id',
      'run_id',
      'sequence',
      'title',
      'status',
      'acceptance_criteria_json',
    ]);
  });

  it('gives agent_tasks exactly the PRD columns, in order', () => {
    expect(columnNames(agentTasks)).toEqual([
      'id',
      'organization_id',
      'phase_id',
      'parent_task_id',
      'title',
      'status',
      'risk_level',
      'base_commit_sha',
      'output_commit_sha',
      'acceptance_criteria_json',
      'dependencies_json',
      'assigned_agent_role',
    ]);
  });

  it('gives approvals exactly the PRD columns, in order', () => {
    expect(columnNames(approvals)).toEqual([
      'id',
      'organization_id',
      'run_id',
      'task_id',
      'type',
      'status',
      'request_json',
      'response_json',
      'requested_at',
      'resolved_at',
      'resolved_by',
    ]);
  });

  it('wires the plan graph together with real foreign keys', () => {
    expect(foreignKeys(specifications)).toEqual([
      'organization_id -> organizations.id',
      'project_id -> projects.id',
      'created_by -> users.id',
      'approved_by -> users.id',
      'project_id, organization_id -> projects.id, organization_id',
    ]);
    // `made_by` is deliberately absent: PRD §12.1 has the agent record an
    // assumption when the user delegates a decision, so it is an actor
    // reference rather than always a user row.
    expect(foreignKeys(decisions)).toEqual([
      'organization_id -> organizations.id',
      'project_id -> projects.id',
      'specification_id -> specifications.id',
      'project_id, organization_id -> projects.id, organization_id',
    ]);
    expect(foreignKeys(agentRuns)).toEqual([
      'organization_id -> organizations.id',
      'project_id -> projects.id',
      'branch_id -> branches.id',
      'specification_id -> specifications.id',
      'started_by -> users.id',
      'project_id, organization_id -> projects.id, organization_id',
    ]);
    expect(foreignKeys(agentPhases)).toEqual([
      'organization_id -> organizations.id',
      'run_id -> agent_runs.id',
    ]);
    expect(foreignKeys(agentTasks)).toEqual([
      'organization_id -> organizations.id',
      'phase_id -> agent_phases.id',
      'parent_task_id -> agent_tasks.id',
    ]);
    expect(foreignKeys(approvals)).toEqual([
      'organization_id -> organizations.id',
      'run_id -> agent_runs.id',
      'task_id -> agent_tasks.id',
      'resolved_by -> users.id',
    ]);
  });

  it('indexes what Mission Control actually reads', () => {
    expect(indexNames(specifications)).toEqual(['specifications_project_version_idx']);
    expect(indexNames(decisions)).toEqual(['decisions_project_specification_idx']);
    expect(indexNames(agentRuns)).toEqual([
      'agent_runs_project_started_at_idx',
      'agent_runs_org_started_at_idx',
    ]);
    // Two phases cannot claim one slot in a plan.
    expect(indexNames(agentPhases)).toEqual(['agent_phases_run_sequence_idx']);
    expect(indexNames(agentTasks)).toEqual(['agent_tasks_phase_idx']);
    expect(indexNames(approvals)).toEqual(['approvals_run_status_idx']);
  });

  it('constrains run modes and app types in the database', () => {
    expect(checkNames(agentRuns)).toEqual([
      'agent_runs_mode_check',
      'agent_runs_app_type_check',
    ]);
    expect(checkExpression(agentRuns, 'agent_runs_mode_check')).toBe(
      "mode in ('ask', 'prototype', 'build', 'fix', 'autonomous')",
    );
    expect(enumValues(agentRuns, 'mode')).toEqual([
      'ask',
      'prototype',
      'build',
      'fix',
      'autonomous',
    ]);
    expect(checkExpression(agentRuns, 'agent_runs_app_type_check')).toBe(
      "app_type in ('web', 'mobile')",
    );
    expect(enumValues(agentRuns, 'app_type')).toEqual(['web', 'mobile']);
  });

  it('constrains task states to the PRD §13.2 eleven, in the database', () => {
    expect(checkNames(agentTasks)).toEqual(['agent_tasks_status_check']);
    expect(checkExpression(agentTasks, 'agent_tasks_status_check')).toBe(
      "status in ('queued', 'blocked', 'ready', 'running', 'waiting_for_approval', 'verifying', 'repairing', 'passed', 'failed', 'cancelled', 'superseded')",
    );
    // Untyped literal: the list is the contract, so a state added, dropped or
    // reordered has to fail here as well as in @zapp/contracts.
    expect(enumValues(agentTasks, 'status')).toEqual([
      'queued',
      'blocked',
      'ready',
      'running',
      'waiting_for_approval',
      'verifying',
      'repairing',
      'passed',
      'failed',
      'cancelled',
      'superseded',
    ]);
  });

  it('leaves run, specification and approval statuses to plan 04', () => {
    expect(checkNames(specifications)).toEqual([]);
    expect(checkNames(approvals)).toEqual([]);
    expect(enumValues(agentRuns, 'status')).toEqual([]);
  });
});
