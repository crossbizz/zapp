import type { ExecutionContract } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { spawnSync } from 'node:child_process';
import { describe, expect, test, vi } from 'vitest';

import {
  createRedactingArtifactSink,
  type GateContext,
  type RawEvidenceArtifactSink,
} from '../src/gates/registry.js';
import { createAccessibilityGate } from '../src/gates/accessibility.js';

const CONTRACT = {
  version: 1,
  package_manager: 'pnpm',
  workspace_root: '.',
  install: { command: 'pnpm install', timeout_seconds: 60 },
  develop: { command: 'pnpm dev', port: 3000 },
} satisfies ExecutionContract;

function runtimeWith(exec: WorkspaceRuntime['exec']): WorkspaceRuntime {
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
  };
}

function context(exec: WorkspaceRuntime['exec']) {
  const stored: Array<{ kind: string; value: unknown; text: string }> = [];
  const raw: RawEvidenceArtifactSink = {
    store(input) {
      const text = new TextDecoder().decode(input.body);
      stored.push({ kind: input.kind, value: JSON.parse(text) as unknown, text });
      return Promise.resolve(`art_${String(stored.length)}`);
    },
  };
  return {
    ctx: {
      runtime: runtimeWith(exec),
      contract: CONTRACT,
      routes: [],
      baseCommit: '1'.repeat(40),
      commit: '2'.repeat(40),
      criteria: ['AC-1'],
      fullSecretScan: false,
      artifacts: createRedactingArtifactSink(raw, {
        redact: (text) => text.replaceAll('registered-secret', '[secret:TEST]'),
      }),
    } satisfies GateContext,
    stored,
  };
}

function axeViolation(impact: 'critical' | 'serious', id: string) {
  return {
    id,
    impact,
    description: `${id} description`,
    help: `${id} help`,
    helpUrl: `https://dequeuniversity.com/rules/axe/4.12/${id}`,
    tags: ['wcag2a'],
    nodes: [
      {
        impact,
        target: ['#checkout'],
        failureSummary: `Fix registered-secret ${id}`,
      },
    ],
  };
}

describe('accessibility gate', () => {
  test('scans only specification-flagged routes and treats serious violations as warnings', async () => {
    const exec = vi.fn<WorkspaceRuntime['exec']>(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          routes: [
            {
              path: '/checkout',
              statusCode: 200,
              violations: [axeViolation('serious', 'label')],
              scanError: null,
            },
            {
              path: '/account',
              statusCode: 200,
              violations: [],
              scanError: null,
            },
          ],
        }),
        stderr: '',
        durationMs: 50,
        truncated: false,
      }),
    );
    const fixture = context(exec);

    const result = await createAccessibilityGate({
      supportLevel: 'verified',
      criticalRoutes: ['/checkout', '/account', '/checkout'],
    }).run(fixture.ctx);

    expect(result).toMatchObject({
      status: 'passed',
      details: {
        routeCount: 2,
        scannedRouteCount: 2,
        criticalViolationCount: 0,
        seriousViolationCount: 1,
        warningCount: 1,
      },
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: 'node',
        cwd: '.',
        timeoutMs: 330_000,
      }),
    );
    const input = JSON.parse(exec.mock.calls[0]?.[0].env?.ZAPP_AXE_PROBE_INPUT ?? '{}') as {
      routes?: unknown;
    };
    expect(input.routes).toEqual(['/checkout', '/account']);
    const program = exec.mock.calls[0]?.[0].args[2];
    if (program === undefined) throw new Error('axe_probe_program_missing');
    const syntaxCheck = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: program,
      encoding: 'utf8',
    });
    expect(syntaxCheck.status, syntaxCheck.stderr).toBe(0);
    expect(program).toContain('/opt/zapp/browser/node_modules/axe-core/axe.js');
    expect(program).toContain("new URL(page.url()).origin !== input.origin");
    expect(program).toContain("throw new Error('cross_origin_redirect')");
    expect(fixture.stored).toHaveLength(2);
    expect(fixture.stored.map(({ kind }) => kind)).toEqual([
      'verification.accessibility.route',
      'verification.accessibility.route',
    ]);
    expect(fixture.stored[0]?.value).toMatchObject({
      path: '/checkout',
      violations: [{ id: 'label', impact: 'serious' }],
    });
    expect(fixture.stored[0]?.text).not.toContain('registered-secret');
  });

  test.each(['verified', 'managed'] as const)(
    'fails %s support when any critical violation is present',
    async (supportLevel) => {
      const exec = vi.fn<WorkspaceRuntime['exec']>(() =>
        Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            routes: [
              {
                path: '/checkout',
                statusCode: 200,
                violations: [axeViolation('critical', 'button-name')],
                scanError: null,
              },
            ],
          }),
          stderr: '',
          durationMs: 20,
          truncated: false,
        }),
      );

      await expect(
        createAccessibilityGate({ supportLevel, criticalRoutes: ['/checkout'] }).run(
          context(exec).ctx,
        ),
      ).resolves.toMatchObject({
        status: 'failed',
        details: { criticalViolationCount: 1, warningCount: 0 },
      });
    },
  );

  test('reports critical findings as warnings without blocking compatible support', async () => {
    const exec = vi.fn<WorkspaceRuntime['exec']>(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          routes: [
            {
              path: '/',
              statusCode: 200,
              violations: [axeViolation('critical', 'html-has-lang')],
              scanError: null,
            },
          ],
        }),
        stderr: '',
        durationMs: 20,
        truncated: false,
      }),
    );

    await expect(
      createAccessibilityGate({ supportLevel: 'compatible', criticalRoutes: ['/'] }).run(
        context(exec).ctx,
      ),
    ).resolves.toMatchObject({
      status: 'passed',
      details: { criticalViolationCount: 1, warningCount: 1 },
    });
  });

  test('is not applicable without critical routes and fails closed on invalid probe output', async () => {
    const unusedExec = vi.fn<WorkspaceRuntime['exec']>();
    const emptyFixture = context(unusedExec);
    await expect(
      createAccessibilityGate({ supportLevel: 'verified', criticalRoutes: [] }).run(emptyFixture.ctx),
    ).resolves.toMatchObject({
      status: 'not_applicable',
      evidenceArtifactIds: ['art_1'],
      details: { error: 'critical_routes_missing', routeCount: 0 },
    });
    expect(unusedExec).not.toHaveBeenCalled();

    const invalidExec = vi.fn<WorkspaceRuntime['exec']>(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: '{not-json',
        stderr: 'registered-secret',
        durationMs: 5,
        truncated: false,
      }),
    );
    const invalidFixture = context(invalidExec);
    await expect(
      createAccessibilityGate({ supportLevel: 'verified', criticalRoutes: ['/'] }).run(
        invalidFixture.ctx,
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      evidenceArtifactIds: ['art_1'],
      details: { error: 'accessibility_probe_failed', routeCount: 0 },
    });
    expect(invalidFixture.stored[0]?.text).not.toContain('registered-secret');
  });
});
