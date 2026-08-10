import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createServiceTokenSigner } from '@zapp/config';
import { newId } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import {
  browserRunIdempotencyKey,
  createPlaywrightBrowserRunner,
  type BrowserRunCompletion,
  type BrowserRunInput,
  type BrowserRunOutput,
  type BrowserRunRecordStore,
  type BrowserWorkspace,
  type BrowserWorkspacePort,
  type BrowserWorkspaceRequest,
  type EvidenceObject,
  type EvidenceObjectStore,
  type WorkspaceExecInput,
  type WorkspaceExecResult,
} from '../../src/runner/playwright.js';

const NOW = new Date('2026-08-10T18:00:00.000Z');
const TOKEN_CONFIG = { secret: 'v'.repeat(64) };
const testRoots: string[] = [];

function input(): BrowserRunInput {
  const organizationId = newId('org');
  const projectId = newId('proj');
  const testRunId = newId('trun');
  return {
    idempotencyKey: browserRunIdempotencyKey({ organizationId, projectId, testRunId }),
    organizationId,
    projectId,
    branchId: newId('br'),
    branchName: 'main',
    workspaceId: newId('ws'),
    workspaceCreatedAt: NOW.toISOString(),
    runId: newId('run'),
    taskId: newId('task'),
    testRunId,
    commitSha: 'a'.repeat(40),
    suitePath: 'e2e',
    previewProxyUrl: 'http://127.0.0.1:4173',
    secretScan: {
      status: 'passed',
      evidenceArtifactId: newId('art'),
    },
  };
}

class MemoryRecords implements BrowserRunRecordStore {
  readonly completions: BrowserRunCompletion[] = [];
  private readonly outputs = new Map<string, BrowserRunOutput>();

  claim(run: BrowserRunInput) {
    const replay = this.outputs.get(run.testRunId);
    return Promise.resolve(replay === undefined ? { kind: 'claimed' as const, leaseStartedAt: NOW } : { kind: 'replay' as const, output: replay });
  }

  complete(completion: BrowserRunCompletion) {
    this.completions.push(completion);
    this.outputs.set(completion.output.testRunId, completion.output);
    return Promise.resolve();
  }
}

class MemoryObjects implements EvidenceObjectStore {
  readonly objects: EvidenceObject[] = [];

  put(object: EvidenceObject) {
    this.objects.push(object);
    return Promise.resolve();
  }
}

function runProcess(command: string, input: WorkspaceExecInput, cwd: string): Promise<WorkspaceExecResult> {
  return new Promise((resolveResult, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, input.args, {
      cwd,
      env: { ...process.env, ...input.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const timeout = setTimeout(() => child.kill('SIGKILL'), input.timeoutMs);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - startedAt,
        truncated: false,
        ...(signal === 'SIGKILL' ? { terminationReason: 'timeout' as const } : {}),
      });
    });
  });
}

class LocalWorkspacePort implements BrowserWorkspacePort {
  readonly requests: BrowserWorkspaceRequest[] = [];
  readonly execs: WorkspaceExecInput[] = [];
  private openCount = 0;

  constructor(private readonly root: string, private readonly expectedCommit: string) {}

  open(request: BrowserWorkspaceRequest): Promise<BrowserWorkspace> {
    this.requests.push(request);
    this.openCount += 1;
    const playwright = resolve(import.meta.dirname, '../../node_modules/.bin/playwright');
    return Promise.resolve({
      imageName: 'forge-web-test',
      commitSha: this.expectedCommit,
      exec: async (execInput) => {
        this.execs.push(execInput);
        return await runProcess(playwright, execInput, this.root);
      },
      readFile: async (path) => await readFile(resolve(this.root, path)),
      writeFile: async (path, data) => {
        const target = resolve(this.root, path);
        await mkdir(resolve(target, '..'), { recursive: true });
        await writeFile(target, data);
      },
      deleteFile: async (path) => {
        await unlink(resolve(this.root, path)).catch((error: unknown) => {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        });
      },
      close: () => Promise.resolve(),
    });
  }

  get opens() {
    return this.openCount;
  }
}

class ScriptedWorkspacePort implements BrowserWorkspacePort {
  readonly execs: WorkspaceExecInput[] = [];
  readonly writes: Array<{ path: string; text: string }> = [];
  private cursor = 0;

  constructor(
    private readonly reports: readonly string[],
    private readonly commitSha: string,
    private readonly closeFailure = false,
    private readonly initialExitCode = 1,
  ) {}

  open(request: BrowserWorkspaceRequest): Promise<BrowserWorkspace> {
    return Promise.resolve({
      imageName: 'forge-web-test',
      commitSha: request.commitSha,
      exec: (execInput) => {
        this.execs.push(execInput);
        const stdout = this.reports[this.cursor] ?? this.reports.at(-1) ?? '{}';
        this.cursor += 1;
        return Promise.resolve({
          exitCode: this.cursor === 1 ? this.initialExitCode : 0,
          stdout,
          stderr: '',
          durationMs: 12,
          truncated: false,
        });
      },
      readFile: () => Promise.resolve(Buffer.from('evidence')),
      writeFile: (path, data) => {
        this.writes.push({ path, text: Buffer.from(data).toString('utf8') });
        return Promise.resolve();
      },
      deleteFile: () => Promise.resolve(),
      close: () =>
        this.closeFailure
          ? Promise.reject(new Error('workspace close failed'))
          : Promise.resolve(),
    });
  }
}

function report(status: 'passed' | 'timedOut', message?: string): string {
  return JSON.stringify({
    suites: [
      {
        title: 'retry fixture',
        file: 'e2e/retry.spec.ts',
        specs: [
          {
            title: 'navigation retries once',
            file: 'e2e/retry.spec.ts',
            line: 4,
            column: 1,
            tests: [
              {
                projectName: 'chromium',
                results: [
                  {
                    status,
                    duration: 12,
                    errors: message === undefined ? [] : [{ message }],
                    attachments: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    errors: [],
  });
}

afterEach(async () => {
  for (const root of testRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('VF-7 browser execution and evidence', () => {
  it('runs a two-case suite through the internal route, links failure evidence, and replays the key', async () => {
    const root = await mkdtemp(resolve(import.meta.dirname, 'runtime-'));
    testRoots.push(root);
    await mkdir(resolve(root, 'e2e'));
    await copyFile(resolve(import.meta.dirname, '../fixtures/two-case.spec.ts'), resolve(root, 'e2e/two-case.spec.ts'));

    const runInput = input();
    const workspaces = new LocalWorkspacePort(root, runInput.commitSha);
    const records = new MemoryRecords();
    const objects = new MemoryObjects();
    const runner = createPlaywrightBrowserRunner({
      workspaces,
      records,
      objects,
      redactor: { redact: (text) => text.replaceAll('registered-secret', '[secret:TEST]') },
      now: () => NOW,
    });
    const signer = createServiceTokenSigner(TOKEN_CONFIG);
    const app = buildApp({ signer, browserRuns: runner, logger: false, now: () => NOW });
    const token = await signer.signServiceToken({
      service: 'orchestrator-worker',
      aud: 'verification-service',
      now: NOW,
    });

    try {
      const request = {
        method: 'POST' as const,
        url: '/internal/verification/browser-run',
        headers: {
          'x-zapp-service-token': token.token,
          'idempotency-key': runInput.idempotencyKey,
        },
        payload: runInput,
      };
      const first = await app.inject(request);
      const second = await app.inject(request);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(first.json()).toMatchObject({
        testRunId: runInput.testRunId,
        status: 'failed',
        summary: { total: 2, passed: 1, failed: 1, flaky: 0 },
      });
      expect(workspaces.opens).toBe(1);
      expect(workspaces.requests).toEqual([
        expect.objectContaining({
          imageName: 'forge-web-test',
          networkProfile: 'restricted_verification',
          commitSha: runInput.commitSha,
        }),
      ]);
      expect(workspaces.execs).toHaveLength(1);
      expect(workspaces.execs[0]).toMatchObject({
        cmd: 'playwright',
      });
      expect(workspaces.execs[0]?.args).toContain('test');
      expect(workspaces.execs[0]?.args).toContain('--reporter=json');
      expect(workspaces.execs[0]?.args).toContain('--trace=retain-on-failure');
      expect(workspaces.execs[0]?.args.join(' ')).not.toMatch(/(?:npm|pnpm|yarn|bun) install/u);

      expect(records.completions).toHaveLength(1);
      const completion = records.completions[0];
      expect(completion?.testRun).toMatchObject({
        id: runInput.testRunId,
        organizationId: runInput.organizationId,
        runId: runInput.runId,
        taskId: runInput.taskId,
        commitSha: runInput.commitSha,
        type: 'browser',
        status: 'failed',
      });
      expect(completion?.testCases).toHaveLength(2);
      const failed = completion?.testCases.find((testCase) => testCase.status === 'failed');
      expect(failed?.evidenceArtifactId).toMatch(/^art_/u);
      const screenshot = completion?.artifacts.find((artifact) => artifact.id === failed?.evidenceArtifactId);
      expect(screenshot).toMatchObject({ type: 'playwright_screenshot' });
      expect(objects.objects.some((object) => object.storageRef === screenshot?.storageRef && object.body.byteLength > 0)).toBe(true);
      expect(objects.objects.some((object) => object.contentHash === createHash('sha256').update(object.body).digest('hex'))).toBe(true);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('retries a timeout once and records the retried pass as flaky', async () => {
    const runInput = input();
    const workspaces = new ScriptedWorkspacePort(
      [
        report('timedOut', 'page.goto: Timeout 30000ms exceeded while navigating'),
        report('passed'),
      ],
      runInput.commitSha,
    );
    const records = new MemoryRecords();
    const output = await createPlaywrightBrowserRunner({
      workspaces,
      records,
      objects: new MemoryObjects(),
      redactor: { redact: (text) => text.replaceAll('registered-secret', '[secret:TEST]') },
      now: () => NOW,
    }).run(runInput);

    expect(workspaces.execs).toHaveLength(2);
    expect(workspaces.execs[1]?.args).toEqual(
      expect.arrayContaining(['e2e/retry.spec.ts:4', '--project', 'chromium']),
    );
    expect(workspaces.writes[0]?.text).toContain('baseURL: "http://127.0.0.1:4173"');
    expect(workspaces.writes[0]?.text).toContain('base.projects.map');
    expect(workspaces.writes[0]?.text).toContain('retries: 0');
    expect(output).toMatchObject({
      status: 'passed',
      summary: { total: 1, passed: 1, failed: 0, flaky: 1 },
    });
    expect(output.summary.cases).toEqual([
      expect.objectContaining({ name: 'navigation retries once', status: 'passed', flaky: true }),
    ]);
    expect(records.completions[0]?.testCases).toEqual([
      expect.objectContaining({ status: 'passed', errorJson: null }),
    ]);
  });

  it('never reports success when Playwright exits nonzero around passing case rows', async () => {
    const runInput = input();
    const records = new MemoryRecords();
    const output = await createPlaywrightBrowserRunner({
      workspaces: new ScriptedWorkspacePort([report('passed')], runInput.commitSha),
      records,
      objects: new MemoryObjects(),
      redactor: { redact: (text) => text },
      now: () => NOW,
    }).run(runInput);

    expect(output).toMatchObject({
      status: 'error',
      summary: { total: 0, errorCode: 'browser_run_failed' },
    });
    expect(records.completions[0]?.testRun.status).toBe('error');
  });

  it('refuses the mutating route without a service token before opening a workspace', async () => {
    const runInput = input();
    const workspaces = new ScriptedWorkspacePort([report('passed')], runInput.commitSha);
    const app = buildApp({
      signer: createServiceTokenSigner(TOKEN_CONFIG),
      browserRuns: createPlaywrightBrowserRunner({
        workspaces,
        records: new MemoryRecords(),
        objects: new MemoryObjects(),
        redactor: { redact: (text) => text },
        now: () => NOW,
      }),
      logger: false,
      now: () => NOW,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/verification/browser-run',
        headers: { 'idempotency-key': runInput.idempotencyKey },
        payload: runInput,
      });
      expect(response.statusCode).toBe(401);
      expect(workspaces.execs).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('stores both redacted attempts in canonical JSON evidence', async () => {
    const runInput = input();
    const objects = new MemoryObjects();
    const workspaces = new ScriptedWorkspacePort(
      [
        report('timedOut', 'page.goto registered-secret timed out while navigating'),
        report('passed'),
      ],
      runInput.commitSha,
    );

    const output = await createPlaywrightBrowserRunner({
      workspaces,
      records: new MemoryRecords(),
      objects,
      redactor: { redact: (text) => text.replaceAll('registered-secret', '[secret:TEST]') },
      now: () => NOW,
    }).run(runInput);

    expect(output.status).toBe('passed');
    const reportObject = objects.objects.find((object) => object.contentType === 'application/json');
    const reportText = Buffer.from(reportObject?.body ?? []).toString('utf8');
    expect(reportText).not.toContain('registered-secret');
    expect(reportText).toContain('[secret:TEST]');
    expect(JSON.parse(reportText)).toMatchObject({
      attempts: [{ kind: 'initial' }, { kind: 'retry' }],
    });
  });

  it('rejects unexpected Playwright-internal retry results', async () => {
    const runInput = input();
    const parsed = JSON.parse(report('passed')) as {
      suites: Array<{ specs: Array<{ tests: Array<{ results: unknown[] }> }> }>;
    };
    parsed.suites[0]?.specs[0]?.tests[0]?.results.push({
      status: 'passed',
      duration: 1,
      errors: [],
      attachments: [],
    });
    const records = new MemoryRecords();

    const output = await createPlaywrightBrowserRunner({
      workspaces: new ScriptedWorkspacePort([JSON.stringify(parsed)], runInput.commitSha),
      records,
      objects: new MemoryObjects(),
      redactor: { redact: (text) => text },
      now: () => NOW,
    }).run(runInput);

    expect(output.status).toBe('error');
    expect(records.completions[0]?.testRun.status).toBe('error');
  });

  it('durably completes a run even when workspace cleanup fails', async () => {
    const runInput = input();
    const records = new MemoryRecords();

    const output = await createPlaywrightBrowserRunner({
      workspaces: new ScriptedWorkspacePort([report('passed')], runInput.commitSha, true, 0),
      records,
      objects: new MemoryObjects(),
      redactor: { redact: (text) => text },
      now: () => NOW,
    }).run(runInput);

    expect(output.status).toBe('error');
    expect(records.completions).toHaveLength(1);
  });
});
