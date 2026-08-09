import type { ExecutionContract } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { describe, expect, test, vi } from 'vitest';

import {
  createBuildGate,
  createDevServerGate,
  createLintGate,
  createRedactingArtifactSink,
  createSecretScanGate,
  createTypecheckGate,
  createUnitTestsGate,
  type GateContext,
  type RawEvidenceArtifactSink,
} from '../src/index.js';

const CONTRACT = {
  version: 1,
  package_manager: 'pnpm',
  workspace_root: '.',
  install: { command: 'pnpm install', timeout_seconds: 60 },
  develop: { command: 'pnpm dev', port: 3000 },
  build: { command: 'pnpm build', timeout_seconds: 45 },
  typecheck: { command: 'pnpm typecheck' },
  lint: { command: 'pnpm lint' },
  test: { unit: 'pnpm test -- --reporter=json' },
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

function context(runtime: WorkspaceRuntime) {
  const stored: Array<{ kind: string; text: string }> = [];
  const raw: RawEvidenceArtifactSink = {
    store(input) {
      stored.push({ kind: input.kind, text: new TextDecoder().decode(input.body) });
      return Promise.resolve(`art_${String(stored.length)}`);
    },
  };
  const artifacts = createRedactingArtifactSink(raw, {
    redact: (text) => text.replaceAll('registered-secret', '[secret:TEST]'),
  });
  return {
    ctx: {
      runtime,
      contract: CONTRACT,
      baseCommit: '1'.repeat(40),
      commit: '2'.repeat(40),
      criteria: ['criterion'],
      fullSecretScan: false,
      artifacts,
    } satisfies GateContext,
    stored,
  };
}

describe('deterministic command gates', () => {
  test('runs build, typecheck, lint, and unit commands with bounded execution and parsed summaries', async () => {
    const exec = vi.fn<WorkspaceRuntime['exec']>((input) => {
      if (input.args[1] === CONTRACT.build.command) {
        return Promise.resolve({
          exitCode: 0,
          stdout: 'built registered-secret',
          stderr: '',
          durationMs: 12,
          truncated: false,
        });
      }
      if (input.args[1] === CONTRACT.typecheck.command) {
        return Promise.resolve({
          exitCode: 2,
          stdout: '',
          stderr: 'src/a.ts(1,1): error TS2322: mismatch',
          durationMs: 13,
          truncated: false,
        });
      }
      if (input.args[1] === CONTRACT.lint.command) {
        return Promise.resolve({
          exitCode: 1,
          stdout: JSON.stringify([{ filePath: 'src/a.ts', errorCount: 2, warningCount: 1 }]),
          stderr: '',
          durationMs: 14,
          truncated: false,
        });
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({ numTotalTests: 4, numPassedTests: 4, numFailedTests: 0 }),
        stderr: '',
        durationMs: 15,
        truncated: false,
      });
    });
    const fixture = context(runtimeWith(exec));

    const results = await Promise.all([
      createBuildGate().run(fixture.ctx),
      createTypecheckGate().run(fixture.ctx),
      createLintGate().run(fixture.ctx),
      createUnitTestsGate().run(fixture.ctx),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'passed',
      'failed',
      'failed',
      'passed',
    ]);
    expect(results[1].details).toMatchObject({ errorCount: 1 });
    expect(results[2].details).toMatchObject({ errorCount: 2, warningCount: 1 });
    expect(results[3].details).toMatchObject({ total: 4, passed: 4, failed: 0 });
    expect(exec.mock.calls.map(([input]) => input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cmd: 'sh', args: ['-lc', 'pnpm build'], timeoutMs: 45_000 }),
        expect.objectContaining({ cmd: 'sh', args: ['-lc', 'pnpm typecheck'] }),
        expect.objectContaining({ cmd: 'sh', args: ['-lc', 'pnpm lint'] }),
        expect.objectContaining({
          cmd: 'sh',
          args: ['-lc', 'pnpm test -- --reporter=json'],
        }),
      ]),
    );
    expect(fixture.stored).toHaveLength(4);
    expect(fixture.stored[0]?.text).toContain('[secret:TEST]');
    expect(fixture.stored[0]?.text).not.toContain('registered-secret');
  });

  test('reports missing optional commands as not applicable without executing', async () => {
    const exec = vi.fn<WorkspaceRuntime['exec']>();
    const fixture = context(runtimeWith(exec));
    const contract = { ...CONTRACT, build: undefined, typecheck: undefined, lint: undefined };
    const ctx = { ...fixture.ctx, contract };

    await expect(createBuildGate().run(ctx)).resolves.toMatchObject({ status: 'not_applicable' });
    await expect(createTypecheckGate().run(ctx)).resolves.toMatchObject({
      status: 'not_applicable',
    });
    await expect(createLintGate().run(ctx)).resolves.toMatchObject({ status: 'not_applicable' });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('secret and dev-server gates', () => {
  test('scans only base..head by default, parses file and line, and redacts the planted value', async () => {
    const planted = ['sk_', 'live_', 'registered-secret'].join('');
    const exec = vi.fn<WorkspaceRuntime['exec']>(() => Promise.resolve({
      exitCode: 1,
      stdout: JSON.stringify([
        {
          RuleID: 'stripe-access-token',
          File: 'src/config.ts',
          StartLine: 7,
          Secret: planted,
          Match: planted,
          Tags: null,
          Link: 'https://example.invalid/repository/blob/commit/src/config.ts#L7',
        },
      ]),
      stderr: '',
      durationMs: 20,
      truncated: false,
    }));
    const fixture = context(runtimeWith(exec));

    const result = await createSecretScanGate().run(fixture.ctx);

    expect(result).toMatchObject({
      status: 'failed',
      details: {
        findings: [{ ruleId: 'stripe-access-token', file: 'src/config.ts', line: 7 }],
      },
    });
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: 'sh',
        args: [
          '-lc',
          expect.stringContaining(`--log-opts=${'1'.repeat(40)}..${'2'.repeat(40)}`),
        ],
      }),
    );
    expect(fixture.stored[0]?.text).not.toContain('registered-secret');
    expect(fixture.stored[0]?.text).not.toContain(['sk_', 'live_'].join(''));
    expect(fixture.stored[0]?.text).toContain('stripe-access-token');
  });

  test('uses the explicit full-history scan flag without interpolating unvalidated revisions', async () => {
    const exec = vi.fn<WorkspaceRuntime['exec']>(() => Promise.resolve({
      exitCode: 0,
      stdout: '[]',
      stderr: '',
      durationMs: 10,
      truncated: false,
    }));
    const fixture = context(runtimeWith(exec));

    await createSecretScanGate().run({ ...fixture.ctx, fullSecretScan: true });
    expect(exec.mock.calls[0]?.[0].args[1]).toContain('--log-opts=--all');
    await expect(
      createSecretScanGate().run({ ...fixture.ctx, commit: 'HEAD; echo unsafe' }),
    ).rejects.toThrow();
  });

  test('starts the contract dev server through the supervisor and stores only redacted evidence', async () => {
    const runtime = runtimeWith(vi.fn(), {
      startDevServer: vi.fn(() => Promise.resolve({ port: 3000, pid: 4242 })),
      health: vi.fn(() => Promise.resolve({ ok: true, details: 'registered-secret ready' })),
    });
    const fixture = context(runtime);

    const passed = await createDevServerGate().run(fixture.ctx);
    expect(passed).toMatchObject({
      status: 'passed',
      details: { port: 3000, pid: 4242, healthy: true },
    });
    expect(JSON.stringify(passed.details)).not.toContain('registered-secret');
    expect(fixture.stored[0]?.text).not.toContain('registered-secret');

    const failedFixture = context(
      runtimeWith(vi.fn(), {
        startDevServer: vi.fn(() => Promise.reject(new Error('registered-secret failure'))),
      }),
    );
    const failed = await createDevServerGate().run(failedFixture.ctx);
    expect(failed).toMatchObject({
      status: 'failed',
      details: { healthy: false, error: 'dev_server_start_failed' },
    });
    expect(JSON.stringify(failed.details)).not.toContain('registered-secret');
    expect(failedFixture.stored[0]?.text).not.toContain('registered-secret');
  });
});
