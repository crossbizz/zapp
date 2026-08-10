import type { ExecutionContract } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { spawnSync } from 'node:child_process';
import { describe, expect, test, vi } from 'vitest';

import {
  createBrowserSmokeGate,
  createBuildGate,
  createDevServerGate,
  createLintGate,
  createPreviewHealthGate,
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

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

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
      routes: [],
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

describe('preview health and browser smoke gates', () => {
  test('loads the contract health path through the preview proxy and fails on console errors', async () => {
    const exec = vi.fn<WorkspaceRuntime['exec']>(() => Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        routes: [
          {
            path: '/healthz',
            statusCode: 200,
            title: 'Health',
            blankRoot: false,
            errorBoundary: false,
            console: [{ type: 'error', text: 'registered-secret exploded' }],
            pageErrors: [],
            failedRequests: [],
            screenshotPath: null,
          },
        ],
      }),
      stderr: '',
      durationMs: 25,
      truncated: false,
    }));
    const fixture = context(runtimeWith(exec));

    const result = await createPreviewHealthGate().run({
      ...fixture.ctx,
      contract: { ...CONTRACT, health: { path: '/healthz' } },
    });

    expect(result).toMatchObject({
      status: 'failed',
      details: {
        path: '/healthz',
        statusCode: 200,
        consoleErrorCount: 1,
        pageErrorCount: 0,
      },
    });
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: 'node',
        cwd: '.',
      }),
    );
    expect(typeof exec.mock.calls[0]?.[0].env?.ZAPP_BROWSER_PROBE_INPUT).toBe('string');
    const probeProgram = exec.mock.calls[0]?.[0].args[2];
    if (probeProgram === undefined) throw new Error('browser_probe_program_missing');
    const syntaxCheck = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: probeProgram,
      encoding: 'utf8',
    });
    expect(syntaxCheck.status, syntaxCheck.stderr).toBe(0);
    const probeInput = parseJson(
      exec.mock.calls[0]?.[0].env?.ZAPP_BROWSER_PROBE_INPUT ?? '{}',
    );
    expect(probeInput).toMatchObject({
      origin: 'http://127.0.0.1:8080',
      routes: ['/healthz'],
      captureScreenshots: false,
      discoverNavLinks: false,
    });
    expect(fixture.stored).toHaveLength(1);
    expect(fixture.stored[0]?.text).toContain('[secret:TEST]');
    expect(fixture.stored[0]?.text).not.toContain('registered-secret');
  });

  test('passes preview health only for HTTP 200 with no uncaught browser errors', async () => {
    const exec = vi.fn<WorkspaceRuntime['exec']>(() => Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        routes: [
          {
            path: '/healthz',
            statusCode: 200,
            title: 'Health',
            blankRoot: false,
            errorBoundary: false,
            console: [{ type: 'log', text: 'ready' }],
            pageErrors: [],
            failedRequests: [],
            screenshotPath: null,
          },
        ],
      }),
      stderr: '',
      durationMs: 20,
      truncated: false,
    }));
    const fixture = context(runtimeWith(exec));

    await expect(
      createPreviewHealthGate().run({
        ...fixture.ctx,
        contract: { ...CONTRACT, health: { path: '/healthz' } },
      }),
    ).resolves.toMatchObject({ status: 'passed', details: { statusCode: 200 } });
  });

  test('fails closed when the execution contract has no health path', async () => {
    const exec = vi.fn<WorkspaceRuntime['exec']>();
    const fixture = context(runtimeWith(exec));

    await expect(createPreviewHealthGate().run(fixture.ctx)).resolves.toMatchObject({
      status: 'failed',
      details: { error: 'health_path_missing' },
    });
    expect(exec).not.toHaveBeenCalled();
    expect(fixture.stored).toHaveLength(1);
  });

  test('does not invent a root route and fails closed when adapters discover no pages', async () => {
    const exec = vi.fn<WorkspaceRuntime['exec']>(() => Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({ routes: [] }),
      stderr: '',
      durationMs: 10,
      truncated: false,
    }));
    const fixture = context(runtimeWith(exec));
    const loginOnly = [
      { path: '/login', kind: 'page', dynamic: false, sourceFile: 'src/login.tsx' },
    ] as const;

    await createBrowserSmokeGate().run({ ...fixture.ctx, routes: loginOnly });
    expect(
      parseJson(exec.mock.calls[0]?.[0].env?.ZAPP_BROWSER_PROBE_INPUT ?? '{}'),
    ).toMatchObject({ routes: ['/login'] });

    const noRoutesExec = vi.fn<WorkspaceRuntime['exec']>();
    const noRoutesFixture = context(runtimeWith(noRoutesExec));
    await expect(createBrowserSmokeGate().run(noRoutesFixture.ctx)).resolves.toMatchObject({
      status: 'failed',
      details: { error: 'browser_routes_missing', routeCount: 0 },
    });
    expect(noRoutesExec).not.toHaveBeenCalled();
  });

  test('prioritizes discovered page routes and stores screenshot, console, and request evidence per route', async () => {
    const evidenceDirectory = `.zapp/evidence/browser-smoke-${'2'.repeat(12)}`;
    const exec = vi.fn<WorkspaceRuntime['exec']>(() => Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        routes: [
          {
            path: '/',
            statusCode: 200,
            title: 'Home',
            blankRoot: false,
            errorBoundary: false,
            console: [{ type: 'log', text: 'ready' }],
            pageErrors: [],
            failedRequests: [],
            screenshotPath: `${evidenceDirectory}/route-01.png`,
          },
          {
            path: '/login',
            statusCode: 200,
            title: 'Login',
            blankRoot: false,
            errorBoundary: false,
            console: [],
            pageErrors: [],
            failedRequests: [
              { url: 'https://example.invalid/metrics', method: 'POST', failure: 'blocked' },
            ],
            screenshotPath: `${evidenceDirectory}/route-02.png`,
          },
          {
            path: '/docs',
            statusCode: 200,
            title: 'Docs',
            blankRoot: true,
            errorBoundary: false,
            console: [],
            pageErrors: [],
            failedRequests: [],
            screenshotPath: `${evidenceDirectory}/route-03.png`,
          },
        ],
      }),
      stderr: '',
      durationMs: 80,
      truncated: false,
    }));
    const readFile = vi.fn<WorkspaceRuntime['readFile']>((path) =>
      Promise.resolve(new TextEncoder().encode(`png:${path}`)),
    );
    const deleteFile = vi.fn<WorkspaceRuntime['deleteFile']>(() => Promise.resolve());
    const fixture = context(runtimeWith(exec, { readFile, deleteFile }));
    const routes = [
      { path: '/docs', kind: 'page', dynamic: false, sourceFile: 'src/docs.tsx' },
      { path: '/api/ping', kind: 'api', dynamic: false, sourceFile: 'src/api.ts' },
      { path: '/login', kind: 'page', dynamic: false, sourceFile: 'src/login.tsx' },
      { path: '/users/[id]', kind: 'page', dynamic: true, sourceFile: 'src/user.tsx' },
      { path: '/', kind: 'page', dynamic: false, sourceFile: 'src/home.tsx' },
    ] as const;

    const result = await createBrowserSmokeGate().run({ ...fixture.ctx, routes });

    expect(result).toMatchObject({
      status: 'failed',
      details: {
        routeCount: 3,
        passedRouteCount: 2,
        failedRouteCount: 1,
      },
    });
    const probeInput = parseJson(
      exec.mock.calls[0]?.[0].env?.ZAPP_BROWSER_PROBE_INPUT ?? '{}',
    );
    expect(probeInput).toMatchObject({ routes: ['/', '/login', '/docs'] });
    expect(readFile).toHaveBeenCalledTimes(3);
    expect(deleteFile).toHaveBeenCalledTimes(3);
    expect(fixture.stored.map(({ kind }) => kind)).toEqual([
      'verification.browser_smoke.route',
      'verification.browser_smoke.route',
      'verification.browser_smoke.route',
      'verification.browser_smoke.summary',
    ]);
    expect(fixture.stored[1]?.text).toContain('cG5nOi56YXBwL2V2aWRlbmNl');
    expect(fixture.stored[1]?.text).toContain('https://example.invalid/metrics');
  });
});
