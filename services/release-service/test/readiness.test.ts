import { describe, expect, it, vi } from 'vitest';

import {
  evaluateReadiness,
  fixAndRecheck,
  type ReadinessEvaluationInput,
} from '../src/release/readiness.js';

const COMMIT = 'a'.repeat(40);
const RELEASE_ID = 'rel_01J00000000000000000000000';
const OPERATION_KEY = `op_${'b'.repeat(64)}`;

function allGreenInput(): ReadinessEvaluationInput {
  return {
    releaseId: RELEASE_ID,
    commitSha: COMMIT,
    supportLevel: 'compatible',
    contract: {
      version: 1,
      package_manager: 'pnpm',
      workspace_root: '.',
      install: { command: 'pnpm install' },
      develop: { command: 'pnpm dev', port: 3_000 },
      build: { command: 'pnpm build' },
      start: { command: 'pnpm start' },
      test: { browser: 'pnpm test:browser' },
      health: { path: '/health' },
    },
    deploymentPlan: {
      providerId: 'fly',
      rationale: 'Generic Node container deployment.',
      requiredEnvVars: ['DATABASE_URL'],
    },
    detectedEnvironmentReads: ['DATABASE_URL'],
    targetEnvironmentVariableNames: ['DATABASE_URL'],
    productionBuild: { commitSha: COMMIT, status: 'passed', detail: 'Production build passed.' },
    productionStart: { commitSha: COMMIT, status: 'passed', detail: 'Production start passed.' },
    lockfileConsistency: { commitSha: COMMIT, status: 'passed', detail: 'Frozen install passed.' },
    database: {
      required: true,
      connectivity: 'passed',
      migrationValidation: 'passed',
      destructiveMigrationApproval: 'not_required',
    },
    providerCompatibility: {
      providerId: 'fly',
      compatible: true,
      reasons: ['Build and start commands are present.'],
    },
    criticalBrowserFlows: {
      commitSha: COMMIT,
      results: [{ id: 'checkout', status: 'passed', detail: 'Checkout passed.' }],
    },
    verification: {
      commitSha: COMMIT,
      decision: 'approved',
      blockingRiskSummaries: [],
      warningRiskSummaries: [],
    },
  };
}

describe('pre-deployment readiness', () => {
  it('returns ready with no findings when every mandatory gate is green', () => {
    expect(evaluateReadiness(allGreenInput())).toEqual({
      releaseId: RELEASE_ID,
      commitSha: COMMIT,
      state: 'ready',
      findings: [],
      blockers: [],
      primaryAction: null,
    });
  });

  it('reports a missing environment value as a warning for connected hosting and a blocker for Managed', () => {
    const nonManaged = allGreenInput();
    nonManaged.targetEnvironmentVariableNames = [];

    expect(evaluateReadiness(nonManaged)).toMatchInlineSnapshot(`
      {
        "blockers": [],
        "commitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "findings": [
          {
            "action": "review",
            "detail": "DATABASE_URL is required by the contract or source but is not configured in the target environment.",
            "id": "missing_environment:DATABASE_URL",
            "severity": "warning",
            "title": "Environment value missing",
          },
        ],
        "primaryAction": null,
        "releaseId": "rel_01J00000000000000000000000",
        "state": "warnings",
      }
    `);

    const managed = { ...nonManaged, supportLevel: 'managed' as const };
    expect(evaluateReadiness(managed)).toEqual({
      releaseId: RELEASE_ID,
      commitSha: COMMIT,
      state: 'blocked',
      findings: [
        {
          id: 'missing_environment:DATABASE_URL',
          severity: 'blocker',
          title: 'Environment value missing',
          detail:
            'DATABASE_URL is required by the contract or source but is not configured in the target environment.',
          action: 'fix_and_recheck',
        },
      ],
      blockers: ['missing_environment:DATABASE_URL'],
      primaryAction: 'fix_and_recheck',
    });
  });

  it('blocks when the latest critical browser flow for the release commit failed', () => {
    const input = allGreenInput();
    input.criticalBrowserFlows.results = [
      { id: 'checkout', status: 'failed', detail: 'Payment confirmation never appeared.' },
    ];

    expect(evaluateReadiness(input)).toEqual({
      releaseId: RELEASE_ID,
      commitSha: COMMIT,
      state: 'blocked',
      findings: [
        {
          id: 'critical_browser_flow:checkout',
          severity: 'blocker',
          title: 'Critical browser flow failed',
          detail: 'Payment confirmation never appeared.',
          action: 'fix_and_recheck',
        },
      ],
      blockers: ['critical_browser_flow:checkout'],
      primaryAction: 'fix_and_recheck',
    });
  });

  it.each([
    ['production build', (input: ReadinessEvaluationInput) => { input.productionBuild.status = 'failed'; }, 'production_build'],
    ['production start command', (input: ReadinessEvaluationInput) => { delete input.contract.start; }, 'production_start'],
    ['production start execution', (input: ReadinessEvaluationInput) => { input.productionStart.status = 'failed'; }, 'production_start'],
    ['frozen lockfile install', (input: ReadinessEvaluationInput) => { input.lockfileConsistency.status = 'failed'; }, 'lockfile_consistency'],
    ['database connectivity', (input: ReadinessEvaluationInput) => { input.database.connectivity = 'failed'; }, 'database_connectivity'],
    ['missing database connectivity evidence', (input: ReadinessEvaluationInput) => { input.database.connectivity = 'not_applicable'; }, 'database_connectivity'],
    ['migration validation', (input: ReadinessEvaluationInput) => { input.database.migrationValidation = 'failed'; }, 'migration_validation'],
    ['missing migration evidence', (input: ReadinessEvaluationInput) => { input.database.migrationValidation = 'not_applicable'; }, 'migration_validation'],
    ['destructive migration approval', (input: ReadinessEvaluationInput) => { input.database.destructiveMigrationApproval = 'missing'; }, 'migration_approval'],
    ['provider compatibility', (input: ReadinessEvaluationInput) => { input.providerCompatibility.compatible = false; }, 'provider_compatibility'],
    ['health endpoint', (input: ReadinessEvaluationInput) => { delete input.contract.health; }, 'health_endpoint'],
    ['release policy', (input: ReadinessEvaluationInput) => { input.verification.decision = 'rejected'; }, 'release_policy'],
  ])('fails closed when %s is not ready', (_label, mutate, findingId) => {
    const input = allGreenInput();
    mutate(input);

    const report = evaluateReadiness(input);

    expect(report.state).toBe('blocked');
    expect(report.blockers).toContain(findingId);
  });

  it('rejects browser evidence from a different commit', () => {
    const input = allGreenInput();
    input.criticalBrowserFlows.commitSha = 'b'.repeat(40);

    expect(evaluateReadiness(input).blockers).toContain('critical_browser_flow_commit');
  });

  it.each([
    ['production build', (input: ReadinessEvaluationInput) => { input.productionBuild.commitSha = 'b'.repeat(40); }, 'production_build'],
    ['production start', (input: ReadinessEvaluationInput) => { input.productionStart.commitSha = 'b'.repeat(40); }, 'production_start'],
    ['lockfile', (input: ReadinessEvaluationInput) => { input.lockfileConsistency.commitSha = 'b'.repeat(40); }, 'lockfile_consistency'],
    ['VF-10 decision', (input: ReadinessEvaluationInput) => { input.verification.commitSha = 'b'.repeat(40); }, 'release_policy_commit'],
  ])('rejects stale %s evidence', (_label, mutate, findingId) => {
    const input = allGreenInput();
    mutate(input);

    expect(evaluateReadiness(input).blockers).toContain(findingId);
  });

  it('accepts not-applicable database checks only when the project declares no database', () => {
    const input = allGreenInput();
    input.database = {
      required: false,
      connectivity: 'not_applicable',
      migrationValidation: 'not_applicable',
      destructiveMigrationApproval: 'not_required',
    };

    expect(evaluateReadiness(input).state).toBe('ready');
  });

  it('turns a VF-10 needs-human decision into a warning', () => {
    const input = allGreenInput();
    input.verification = {
      commitSha: COMMIT,
      decision: 'needs_human',
      blockingRiskSummaries: [],
      warningRiskSummaries: ['Criterion AC-4 was explicitly waived.'],
    };

    expect(evaluateReadiness(input)).toMatchObject({
      state: 'warnings',
      findings: [
        expect.objectContaining({
          id: 'release_policy',
          severity: 'warning',
          action: 'review',
        }),
      ],
    });
  });

  it('spawns an AR-19 Fix run from the blocked report primary action', async () => {
    const input = allGreenInput();
    input.productionBuild.status = 'failed';
    const report = evaluateReadiness(input);
    const startFixRun = vi.fn().mockResolvedValue({ runId: 'run_01J00000000000000000000000' });

    await expect(
      fixAndRecheck({ report, operationKey: OPERATION_KEY }, { startFixRun }),
    ).resolves.toEqual({ runId: 'run_01J00000000000000000000000' });
    expect(startFixRun).toHaveBeenCalledWith({
      releaseId: RELEASE_ID,
      commitSha: COMMIT,
      findingIds: ['production_build'],
      operationKey: OPERATION_KEY,
    });
  });
});
