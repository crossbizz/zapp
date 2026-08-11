import type { ExecutionContract } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { describe, expect, test, vi } from 'vitest';

import {
  createDependencyScanGate,
  createMigrationValidationGate,
  createRedactingArtifactSink,
  decideVerification,
  type GateContext,
  type MigrationValidationAdapter,
  type RawEvidenceArtifactSink,
} from '../src/index.js';

const CONTRACT = {
  version: 1,
  package_manager: 'pnpm',
  workspace_root: '.',
  install: { command: 'pnpm install', timeout_seconds: 60 },
  develop: { command: 'pnpm dev', port: 3000 },
  build: { command: 'pnpm build', timeout_seconds: 45 },
} satisfies ExecutionContract;

function runtimeWith(
  exec: WorkspaceRuntime['exec'],
  overrides: Partial<WorkspaceRuntime> = {},
): WorkspaceRuntime {
  const unavailable = (): Promise<never> => Promise.reject(new Error('unused_runtime_method'));
  return {
    kind: 'cloud',
    exec,
    execStream: () => ({
      [Symbol.asyncIterator]: async function* () {
        await Promise.resolve();
      },
    }),
    readFile: unavailable,
    readFileForUpdate: unavailable,
    writeFile: unavailable,
    writeFilesAtomically: unavailable,
    search: unavailable,
    listFiles: unavailable,
    stat: unavailable,
    delete: unavailable,
    deleteFile: unavailable,
    renameFile: unavailable,
    git: unavailable,
    startDevServer: unavailable,
    restartDevServer: unavailable,
    health: unavailable,
    ...overrides,
  };
}

function fixture(runtime: WorkspaceRuntime) {
  const stored: Array<{ kind: string; text: string }> = [];
  const raw: RawEvidenceArtifactSink = {
    store(input) {
      stored.push({ kind: input.kind, text: new TextDecoder().decode(input.body) });
      return Promise.resolve(`art_${String(stored.length)}`);
    },
  };
  return {
    ctx: {
      runtime,
      contract: CONTRACT,
      routes: [],
      baseCommit: '1'.repeat(40),
      commit: '2'.repeat(40),
      criteria: ['criterion'],
      fullSecretScan: false,
      artifacts: createRedactingArtifactSink(raw, {
        redact: (text) => text.replaceAll('registered-secret', '[secret:TEST]'),
      }),
    } satisfies GateContext,
    stored,
  };
}

function osvResult(maxSeverity: string): string {
  return JSON.stringify({
    results: [
      {
        source: { path: 'pnpm-lock.yaml', type: 'lockfile' },
        packages: [
          {
            package: { name: 'fixture-package', version: '1.2.3', ecosystem: 'npm' },
            vulnerabilities: [{ id: 'GHSA-TEST-CRITICAL' }],
            groups: [
              {
                ids: ['GHSA-TEST-CRITICAL', 'CVE-2026-0001'],
                max_severity: maxSeverity,
              },
            ],
          },
        ],
      },
    ],
  });
}

describe('dependency scan gate', () => {
  test('runs OSV against the detected lockfile and blocks an unwaived critical finding', async () => {
    const exec = vi.fn<WorkspaceRuntime['exec']>(() =>
      Promise.resolve({
        exitCode: 1,
        stdout: osvResult('9.8'),
        stderr: 'registered-secret',
        durationMs: 15,
        truncated: false,
      }),
    );
    const scan = fixture(
      runtimeWith(exec, {
        listFiles: () => Promise.resolve([{ path: 'pnpm-lock.yaml', type: 'file' }]),
      }),
    );

    const result = await createDependencyScanGate().run(scan.ctx);

    expect(result).toMatchObject({
      status: 'failed',
      details: {
        lockfile: 'pnpm-lock.yaml',
        findingCount: 1,
        criticalCount: 1,
        waivedCriticalCount: 0,
      },
    });
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '.',
        timeoutMs: 300_000,
        cmd: 'sh',
        args: [
          '-lc',
          expect.stringMatching(
            /osv-scanner scan source --offline .*--format=json .*--config="\$config" .*--lockfile=pnpm-lock\.yaml/,
          ),
        ],
      }),
    );
    expect(scan.stored).toHaveLength(1);
    expect(scan.stored[0]?.kind).toBe('dependency_scan');
    expect(scan.stored[0]?.text).toContain('[secret:TEST]');
    expect(scan.stored[0]?.text).not.toContain('registered-secret');
  });

  test('accepts only actor-attributed vulnerability waivers and keeps non-critical findings advisory', async () => {
    const exec = vi.fn<WorkspaceRuntime['exec']>(() =>
      Promise.resolve({
        exitCode: 1,
        stdout: osvResult('9.8'),
        stderr: '',
        durationMs: 12,
        truncated: false,
      }),
    );
    const scan = fixture(
      runtimeWith(exec, {
        listFiles: () => Promise.resolve([{ path: 'pnpm-lock.yaml', type: 'file' }]),
      }),
    );
    const waiver = {
      vulnerabilityId: 'GHSA-TEST-CRITICAL',
      actorId: 'user_01K1J6G0V8ZQ5Y7J3X9M2N4P6R',
      reason: 'Accepted until the upstream patch is released.',
      createdAt: '2026-08-10T18:00:00.000Z',
    };

    await expect(createDependencyScanGate({ waivers: [waiver] }).run(scan.ctx)).resolves.toMatchObject({
      status: 'passed',
      details: { criticalCount: 1, waivedCriticalCount: 1 },
    });
    expect(scan.stored[0]?.text).toContain(waiver.actorId);

    const advisoryExec = vi.fn<WorkspaceRuntime['exec']>(() =>
      Promise.resolve({
        exitCode: 1,
        stdout: osvResult('7.4'),
        stderr: '',
        durationMs: 11,
        truncated: false,
      }),
    );
    const advisory = fixture(
      runtimeWith(advisoryExec, {
        listFiles: () => Promise.resolve([{ path: 'pnpm-lock.yaml', type: 'file' }]),
      }),
    );
    await expect(createDependencyScanGate().run(advisory.ctx)).resolves.toMatchObject({
      status: 'passed',
      details: { findingCount: 1, criticalCount: 0 },
    });
    expect(() =>
      createDependencyScanGate({
        waivers: [{ ...waiver, actorId: 'not-a-user-id' }],
      }),
    ).toThrow();
  });

  test('returns not applicable without a lockfile and fails closed on scanner failure', async () => {
    const noExec = vi.fn<WorkspaceRuntime['exec']>();
    const missing = fixture(runtimeWith(noExec, { listFiles: () => Promise.resolve([]) }));

    await expect(createDependencyScanGate().run(missing.ctx)).resolves.toMatchObject({
      status: 'not_applicable',
      details: { reason: 'dependency_lockfile_absent' },
    });
    expect(noExec).not.toHaveBeenCalled();

    const exec = vi.fn<WorkspaceRuntime['exec']>(() =>
      Promise.resolve({
        exitCode: 2,
        stdout: 'not-json',
        stderr: 'scanner failed with registered-secret',
        durationMs: 9,
        truncated: false,
      }),
    );
    const failed = fixture(
      runtimeWith(exec, {
        listFiles: () => Promise.resolve([{ path: 'pnpm-lock.yaml', type: 'file' }]),
      }),
    );

    await expect(createDependencyScanGate().run(failed.ctx)).resolves.toMatchObject({
      status: 'failed',
      details: { reason: 'dependency_scanner_failed' },
    });
    expect(failed.stored[0]?.text).toContain('[secret:TEST]');
    expect(failed.stored[0]?.text).not.toContain('registered-secret');
  });

  test('rejects valid-looking partial output from a terminated scan', async () => {
    const exec = vi.fn<WorkspaceRuntime['exec']>(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({ results: [] }),
        stderr: '',
        durationMs: 300_000,
        truncated: false,
        terminationReason: 'timeout',
      }),
    );
    const scan = fixture(
      runtimeWith(exec, {
        listFiles: () => Promise.resolve([{ path: 'pnpm-lock.yaml', type: 'file' }]),
      }),
    );

    await expect(createDependencyScanGate().run(scan.ctx)).resolves.toMatchObject({
      status: 'failed',
      details: { reason: 'dependency_scanner_failed' },
    });
  });

  test('keeps a failed advisory scan non-blocking for Compatible and blocking for Verified+', () => {
    const criterion = {
      criterionId: 'AC-1',
      specificationVersion: 1,
      taskIds: ['task_01J00000000000000000000000'],
      testCaseIds: ['tcase_01'],
      result: 'passed' as const,
      evidenceArtifactIds: ['art_criterion'],
      verifierComments: [],
    };
    const result = {
      status: 'failed' as const,
      evidenceArtifactIds: ['art_scan'],
      details: { criticalCount: 1 },
    };

    expect(
      decideVerification({
        gateEvaluations: [{ gateId: 'dependency_scan', class: 'advisory', result }],
        criteria: [criterion],
        criticalCriterionIds: [],
      }),
    ).toMatchObject({
      decision: 'approved',
      risks: [{ code: 'gate_failed', severity: 'warning', gateId: 'dependency_scan' }],
    });
    expect(
      decideVerification({
        gateEvaluations: [{ gateId: 'dependency_scan', class: 'required_policy', result }],
        criteria: [criterion],
        criticalCriterionIds: [],
      }).decision,
    ).toBe('rejected');
  });
});

describe('migration validation gate', () => {
  test('validates pending migrations on an isolated target and classifies destructive SQL with AR-5', async () => {
    const sql = 'ALTER TABLE accounts DROP COLUMN legacy SQL_BODY_SENTINEL';
    const validatePendingMigrations = vi.fn<MigrationValidationAdapter['validatePendingMigrations']>(
      () =>
        Promise.resolve({
          kind: 'validated',
          provider: 'neon',
          isolatedTarget: { kind: 'neon_branch', reference: 'br_verify_01' },
          migrations: [
            { path: 'migrations/001_add.sql', sql: 'ALTER TABLE accounts ADD COLUMN active bool' },
            { path: 'migrations/002_drop.sql', sql },
          ],
          applyStatus: 'passed',
          smokeStatus: 'passed',
          cleanupStatus: 'passed',
          reversibility: 'compensating',
        }),
    );
    const scan = fixture(runtimeWith(vi.fn<WorkspaceRuntime['exec']>()));

    const result = await createMigrationValidationGate({ validatePendingMigrations }).run(scan.ctx);

    expect(validatePendingMigrations).toHaveBeenCalledWith({
      commitSha: '2'.repeat(40),
      workspaceRoot: '.',
    });
    expect(result).toMatchObject({
      status: 'passed',
      details: {
        provider: 'neon',
        isolatedTargetKind: 'neon_branch',
        migrationCount: 2,
        destructiveMigrationCount: 1,
        approvalRequired: true,
        reversibility: 'compensating',
      },
    });
    expect(scan.stored[0]?.kind).toBe('migration_validation');
    expect(scan.stored[0]?.text).toContain('migrations/002_drop.sql');
    expect(scan.stored[0]?.text).toContain('"destructive":true');
    expect(scan.stored[0]?.text).not.toContain(sql);
    expect(scan.stored[0]?.text).not.toContain('SQL_BODY_SENTINEL');
  });

  test('records no pending migrations as reversible evidence', async () => {
    const validatePendingMigrations = vi.fn<MigrationValidationAdapter['validatePendingMigrations']>(
      () => Promise.resolve({ kind: 'no_pending_migrations', provider: 'supabase' }),
    );
    const scan = fixture(runtimeWith(vi.fn<WorkspaceRuntime['exec']>()));

    await expect(
      createMigrationValidationGate({ validatePendingMigrations }).run(scan.ctx),
    ).resolves.toMatchObject({
      status: 'passed',
      details: {
        provider: 'supabase',
        migrationCount: 0,
        destructiveMigrationCount: 0,
        approvalRequired: false,
        reversibility: 'reversible',
      },
    });
    expect(scan.stored).toHaveLength(1);
  });

  test('fails a bad stage, invalid receipt, or adapter error without leaking SQL or errors', async () => {
    const scan = fixture(runtimeWith(vi.fn<WorkspaceRuntime['exec']>()));
    const failedAdapter: MigrationValidationAdapter = {
      validatePendingMigrations: () =>
        Promise.resolve({
          kind: 'validated',
          provider: 'supabase',
          isolatedTarget: { kind: 'supabase_shadow', reference: 'shadow_01' },
          migrations: [{ path: 'migrations/001.sql', sql: 'SELECT 1' }],
          applyStatus: 'passed',
          smokeStatus: 'failed',
          cleanupStatus: 'passed',
          reversibility: 'unavailable',
        }),
    };

    await expect(createMigrationValidationGate(failedAdapter).run(scan.ctx)).resolves.toMatchObject({
      status: 'failed',
      details: { smokeStatus: 'failed', reversibility: 'unavailable' },
    });

    const invalid = fixture(runtimeWith(vi.fn<WorkspaceRuntime['exec']>()));
    const invalidAdapter: MigrationValidationAdapter = {
      validatePendingMigrations: () =>
        Promise.resolve({
          kind: 'validated',
          provider: 'neon',
          isolatedTarget: { kind: 'supabase_shadow', reference: 'wrong_target' },
          migrations: [{ path: 'migrations/001.sql', sql: 'SELECT 1' }],
          applyStatus: 'passed',
          smokeStatus: 'passed',
          cleanupStatus: 'passed',
          reversibility: 'reversible',
        }),
    };
    await expect(createMigrationValidationGate(invalidAdapter).run(invalid.ctx)).resolves.toMatchObject({
      status: 'failed',
      details: {
        reason: 'migration_validation_receipt_invalid',
        reversibility: 'unavailable',
      },
    });

    const rejected = fixture(runtimeWith(vi.fn<WorkspaceRuntime['exec']>()));
    const rejectedAdapter: MigrationValidationAdapter = {
      validatePendingMigrations: () => Promise.reject(new Error('registered-secret adapter error')),
    };
    await expect(createMigrationValidationGate(rejectedAdapter).run(rejected.ctx)).resolves.toMatchObject({
      status: 'failed',
      details: {
        reason: 'migration_validation_adapter_failed',
        reversibility: 'unavailable',
      },
    });
    expect(rejected.stored[0]?.text).toContain('[secret:TEST]');
    expect(rejected.stored[0]?.text).not.toContain('registered-secret');
  });

  test('returns not applicable when no Plan 06 adapter is configured', async () => {
    const scan = fixture(runtimeWith(vi.fn<WorkspaceRuntime['exec']>()));

    await expect(createMigrationValidationGate().run(scan.ctx)).resolves.toMatchObject({
      status: 'not_applicable',
      evidenceArtifactIds: [],
      details: { reason: 'migration_validation_adapter_absent' },
    });
  });
});
