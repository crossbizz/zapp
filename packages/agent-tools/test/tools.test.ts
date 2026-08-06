import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_GROUPS, TOOL_NAMES, type ExecutionContract, type ToolName } from '@zapp/contracts';
import {
  MemoryWorkspaceRuntime,
  PathViolationError,
  type ExecChunk,
  type ExecResult,
  type FileEntry,
  type FileStat,
  type GitOp,
  type GitResult,
  type WorkspaceRuntime,
} from '@zapp/workspace-runtime';
import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  type BrowserEvidencePort,
  type EnvironmentPort,
  type MigrationPort,
  type OutputRedactor,
  type ProjectDataPort,
  type ReleasePort,
  type ToolRegistryDependencies,
} from '../src/registry.js';

const attribution = {
  organizationId: 'org_test',
  projectId: 'project_test',
  runId: 'run_test',
  taskId: 'task_test',
} as const;

const contract: ExecutionContract = {
  version: 1,
  package_manager: 'pnpm',
  workspace_root: '.',
  install: { command: 'pnpm install' },
  develop: { command: 'pnpm dev', port: 3000 },
  build: { command: 'pnpm build' },
  typecheck: { command: 'pnpm typecheck' },
  lint: { command: 'pnpm lint' },
  test: { unit: 'pnpm test', browser: 'pnpm test:browser' },
};

class RecordingRuntime implements WorkspaceRuntime {
  readonly kind = 'local' as const;
  readonly execCalls: Array<Parameters<WorkspaceRuntime['exec']>[0]> = [];
  readonly gitCalls: GitOp[] = [];
  execResult: ExecResult = {
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    truncated: false,
  };
  readonly files = new Map<string, Uint8Array>([
    ['source.txt', new TextEncoder().encode('source')],
    ['rename.txt', new TextEncoder().encode('rename')],
    ['delete.txt', new TextEncoder().encode('delete')],
  ]);

  exec(input: Parameters<WorkspaceRuntime['exec']>[0]): Promise<ExecResult> {
    this.execCalls.push(input);
    return Promise.resolve(this.execResult);
  }

  async *execStream(
    input: Parameters<WorkspaceRuntime['execStream']>[0],
  ): AsyncIterable<ExecChunk> {
    void input;
    await Promise.resolve();
  }

  readFile(path: string): Promise<Uint8Array> {
    const value = this.files.get(path);
    if (value === undefined) {
      return Promise.reject(new Error(`Missing test file: ${path}`));
    }
    return Promise.resolve(value);
  }

  writeFile(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
    return Promise.resolve();
  }

  listFiles(path: string, opts?: { glob?: string; maxDepth?: number }): Promise<FileEntry[]> {
    void path;
    void opts;
    return Promise.resolve(
      [...this.files.keys()].map((entryPath) => ({
        path: entryPath,
        type: 'file' as const,
      })),
    );
  }

  async stat(path: string): Promise<FileStat> {
    const value = await this.readFile(path);
    return { path, type: 'file', size: value.byteLength, mtimeMs: 1 };
  }

  delete(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  git(op: GitOp): Promise<GitResult> {
    this.gitCalls.push(op);
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }

  startDevServer(contractInput: ExecutionContract): Promise<{ port: number; pid: number }> {
    void contractInput;
    return Promise.resolve({ port: 3000, pid: 42 });
  }

  health(): Promise<{ ok: boolean; details: string }> {
    return Promise.resolve({ ok: true, details: 'ready' });
  }
}

function defaultPorts(): Omit<ToolRegistryDependencies, 'runtime'> {
  const redactor: OutputRedactor = {
    redact: (value) => value.replaceAll('raw-marker', '[REDACTED]'),
  };
  const projectData: ProjectDataPort = {
    readLogs: () => Promise.resolve({ ok: true, entries: [], truncated: false }),
    readTestResults: () =>
      Promise.resolve({
        ok: true,
        status: 'passed',
        summary: 'Checks passed',
        artifactId: 'artifact_tests',
      }),
    readDatabaseSchema: () =>
      Promise.resolve({
        ok: true,
        dialect: 'postgresql',
        schema: 'public',
      }),
    readLatestProjectContract: () => Promise.resolve({ ok: true, version: 3, contract }),
  };
  const migrations: MigrationPort = {
    executeMigration: () =>
      Promise.resolve({
        ok: true,
        migrationId: 'migration_test',
        status: 'applied',
      }),
  };
  const environment: EnvironmentPort = {
    setEnvironmentVariable: () =>
      Promise.resolve({
        ok: true,
        updated: true,
        name: 'CONFIG_VALUE',
        scope: 'preview',
      }),
  };
  const browser: BrowserEvidencePort = {
    runBrowserTests: () =>
      Promise.resolve({ ok: true, passed: true, summary: 'Browser checks passed' }),
    captureScreenshot: () =>
      Promise.resolve({
        ok: true,
        artifactId: 'artifact_screenshot',
        path: 'artifacts/home.png',
      }),
    inspectConsole: () => Promise.resolve({ ok: true, entries: [] }),
    inspectNetwork: () => Promise.resolve({ ok: true, requests: [] }),
  };
  const release: ReleasePort = {
    createPreview: () =>
      Promise.resolve({
        ok: true,
        previewId: 'preview_test',
        url: 'https://preview.example.test',
      }),
    runPreviewSmokeTest: () =>
      Promise.resolve({ ok: true, passed: true, summary: 'Preview healthy' }),
    createReleaseCandidate: () =>
      Promise.resolve({
        ok: true,
        releaseId: 'release_test',
        status: 'candidate',
      }),
    deployRelease: () =>
      Promise.resolve({
        ok: true,
        deploymentId: 'deployment_test',
        status: 'deploying',
      }),
    checkDeploymentHealth: () => Promise.resolve({ ok: true, healthy: true, details: 'healthy' }),
    rollbackRelease: () =>
      Promise.resolve({
        ok: true,
        deploymentId: 'deployment_rollback',
        status: 'rolling_back',
      }),
  };
  return { redactor, projectData, migrations, environment, browser, release };
}

function registryFor(
  runtime: WorkspaceRuntime,
  overrides: Partial<Omit<ToolRegistryDependencies, 'runtime'>> = {},
): ToolRegistry {
  return new ToolRegistry({ runtime, ...defaultPorts(), ...overrides });
}

async function withMemoryRegistry(
  run: (runtime: MemoryWorkspaceRuntime, registry: ToolRegistry) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'zapp-agent-tools-'));
  const runtime = new MemoryWorkspaceRuntime(root);
  try {
    await run(runtime, registryFor(runtime));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const toolInputs: Record<ToolName, unknown> = {
  read_file: { path: 'source.txt' },
  list_files: { path: '.', maxDepth: 2 },
  file_stats: { path: 'source.txt' },
  search_code: { query: 'source', path: '.' },
  grep: { pattern: 'source', path: '.', fixedStrings: true },
  git_status: {},
  git_diff: { cached: false },
  git_log: { maxCount: 10 },
  git_show: { ref: '0123456789abcdef0123456789abcdef01234567' },
  read_logs: { ...attribution, limit: 50 },
  read_test_results: { ...attribution, suite: 'unit' },
  read_database_schema: { ...attribution, environmentId: 'environment_test' },
  read_project_contract: attribution,
  write_file: { path: 'written.txt', content: 'written' },
  apply_patch: {
    patch: '--- a/source.txt\n+++ b/source.txt\n@@ -1,1 +1,1 @@\n-source\n+updated\n',
  },
  copy_file: { source: 'source.txt', destination: 'copied.txt' },
  rename_file: { source: 'rename.txt', destination: 'renamed.txt' },
  delete_file: { path: 'delete.txt' },
  install_dependency: { packageManager: 'pnpm', packages: ['zod'], dev: false },
  execute_migration: {
    ...attribution,
    environmentId: 'environment_test',
    idempotencyKey: 'migration-key',
    migration: 'CREATE TABLE sample (id text)',
  },
  set_environment_variable: {
    ...attribution,
    environmentId: 'environment_test',
    idempotencyKey: 'environment-key',
    name: 'CONFIG_VALUE',
    value: 'private-marker',
    scope: 'preview',
  },
  run_command: { cmd: 'node', args: ['--version'] },
  run_dev_server: { contract },
  restart_dev_server: { contract },
  run_build: { cmd: 'pnpm', args: ['build'] },
  run_typecheck: { cmd: 'pnpm', args: ['typecheck'] },
  run_lint: { cmd: 'pnpm', args: ['lint'] },
  run_unit_tests: { cmd: 'pnpm', args: ['test'] },
  run_integration_tests: { cmd: 'pnpm', args: ['test:integration'] },
  run_browser_tests: { ...attribution, baseUrl: 'https://preview.example.test' },
  capture_screenshot: {
    ...attribution,
    url: 'https://preview.example.test',
    name: 'home',
  },
  inspect_browser_console: { ...attribution, sessionId: 'browser_session' },
  inspect_network_requests: { ...attribution, sessionId: 'browser_session' },
  create_branch: { name: 'feature/agent-tools' },
  create_checkpoint: { paths: ['source.txt'], message: 'checkpoint' },
  commit_changes: { paths: ['source.txt'], message: 'change' },
  restore_file: { path: 'source.txt' },
  revert_commit: { commit: '0123456789abcdef0123456789abcdef01234567' },
  merge_branch: { ref: 'feature/agent-tools' },
  create_preview: { ...attribution, branchId: 'branch_test', commitSha: '0123456789abcdef' },
  run_preview_smoke_test: { ...attribution, previewId: 'preview_test' },
  create_release_candidate: {
    ...attribution,
    environmentId: 'environment_test',
    commitSha: '0123456789abcdef',
    specificationId: 'specification_test',
  },
  deploy_release: {
    ...attribution,
    releaseId: 'release_test',
    deploymentType: 'managed',
    confirmationId: 'confirmation_test',
  },
  check_deployment_health: { ...attribution, deploymentId: 'deployment_test' },
  rollback_release: {
    ...attribution,
    environmentId: 'environment_test',
    toDeploymentId: 'deployment_previous',
    reason: 'Regression detected',
  },
};

describe('ToolRegistry contract', () => {
  it('registers exactly TOOL_NAMES in contractual order with executable strict definitions', async () => {
    const registry = registryFor(new RecordingRuntime());

    expect(registry.names()).toEqual(TOOL_NAMES);
    expect(new Set(registry.names())).toEqual(new Set(TOOL_NAMES));

    for (const name of TOOL_NAMES) {
      const definition = registry.get(name);
      expect(definition.name).toBe(name);
      expect(definition.timeoutMs).toBeGreaterThan(0);
      expect(definition.retryPolicy.maxAttempts).toBeGreaterThan(0);
      expect(definition.retryPolicy.backoffMs).toBeGreaterThanOrEqual(0);
      expect(typeof definition.execute).toBe('function');

      const input = toolInputs[name];
      expect(definition.inputSchema.safeParse(input).success).toBe(true);
      expect(
        definition.inputSchema.safeParse({ ...(input as object), unexpected: true }).success,
      ).toBe(false);
      const output = await definition.execute(input);
      expect(definition.outputSchema.safeParse(output).success).toBe(true);
      expect(
        definition.outputSchema.safeParse({ ...(output as object), unexpected: true }).success,
      ).toBe(false);

      const parsedInput = definition.inputSchema.parse(input);
      const parsedOutput = definition.outputSchema.parse(output);
      const summary = definition.userSummary(parsedInput, parsedOutput);
      const audit = definition.auditPayload(parsedInput, parsedOutput);
      expect(summary.length).toBeGreaterThan(0);
      expect(
        Object.values(audit).every((value) =>
          ['string', 'number', 'boolean'].includes(typeof value),
        ),
      ).toBe(true);
    }
  });

  it('uses the binding metadata classifications and human approval for deploy and rollback', () => {
    const registry = registryFor(new RecordingRuntime());
    for (const name of TOOL_GROUPS.read) {
      expect(registry.get(name)).toMatchObject({
        classification: 'read_only',
        riskLevel: 'low',
        approvalPolicy: 'auto',
      });
    }
    for (const name of [
      'write_file',
      'apply_patch',
      'copy_file',
      'rename_file',
      'delete_file',
      'install_dependency',
      ...TOOL_GROUPS.execution,
      ...TOOL_GROUPS.git,
    ] as const) {
      expect(registry.get(name)).toMatchObject({
        classification: 'mutating',
        riskLevel: 'medium',
        approvalPolicy: 'policy',
      });
    }
    for (const name of [
      'execute_migration',
      'set_environment_variable',
      'create_preview',
      'run_preview_smoke_test',
      'create_release_candidate',
      'check_deployment_health',
    ] as const) {
      expect(registry.get(name)).toMatchObject({
        classification: 'mutating',
        riskLevel: 'high',
        approvalPolicy: 'policy',
      });
    }
    for (const name of ['deploy_release', 'rollback_release'] as const) {
      expect(registry.get(name)).toMatchObject({
        classification: 'mutating',
        riskLevel: 'high',
        approvalPolicy: 'human',
      });
    }
    for (const name of TOOL_GROUPS.execution) {
      expect(registry.get(name).redactOutput).toBe(true);
    }
  });
});

describe('workspace-bound tools', () => {
  it('preserves WorkspaceRuntime rejection of a read_file escape path', async () => {
    await withMemoryRegistry(async (_runtime, registry) => {
      await expect(registry.execute('read_file', { path: '../outside' })).rejects.toBeInstanceOf(
        PathViolationError,
      );
    });
  });

  it('applies a unified patch atomically and reports patch_conflict without a partial write', async () => {
    await withMemoryRegistry(async (runtime, registry) => {
      await runtime.writeFile('app.ts', new TextEncoder().encode('first\nsecond\nthird\n'));
      await expect(
        registry.execute('apply_patch', {
          patch: '--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,3 @@\n first\n-second\n+changed\n third\n',
        }),
      ).resolves.toMatchObject({ ok: true, filesChanged: 1, hunksApplied: 1 });
      await expect(runtime.readFile('app.ts')).resolves.toEqual(
        new TextEncoder().encode('first\nchanged\nthird\n'),
      );

      const conflict = await registry.execute('apply_patch', {
        patch:
          '--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,3 @@\n first\n-missing-context\n+wrong\n third\n',
      });
      expect(conflict).toMatchObject({
        ok: false,
        error: { code: 'patch_conflict' },
      });
      await expect(runtime.readFile('app.ts')).resolves.toEqual(
        new TextEncoder().encode('first\nchanged\nthird\n'),
      );
    });
  });

  it('stages every patched file before writing when a later file conflicts', async () => {
    await withMemoryRegistry(async (runtime, registry) => {
      await runtime.writeFile('first.txt', new TextEncoder().encode('first\n'));
      await runtime.writeFile('second.txt', new TextEncoder().encode('second\n'));

      await expect(
        registry.execute('apply_patch', {
          patch:
            '--- a/first.txt\n+++ b/first.txt\n@@ -1,1 +1,1 @@\n-first\n+changed\n--- a/second.txt\n+++ b/second.txt\n@@ -1,1 +1,1 @@\n-missing\n+wrong\n',
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'patch_conflict' } });
      await expect(runtime.readFile('first.txt')).resolves.toEqual(
        new TextEncoder().encode('first\n'),
      );
      await expect(runtime.readFile('second.txt')).resolves.toEqual(
        new TextEncoder().encode('second\n'),
      );
    });
  });

  it('runs search_code through rg on WorkspaceRuntime.exec', async () => {
    const runtime = new RecordingRuntime();
    runtime.execResult = {
      exitCode: 0,
      stdout: 'src/app.ts:2:needle\n',
      stderr: '',
      durationMs: 2,
      truncated: false,
    };
    const result = await registryFor(runtime).execute('search_code', {
      query: 'needle',
      path: 'src',
      glob: '*.ts',
    });

    expect(runtime.execCalls).toEqual([
      {
        cmd: 'rg',
        args: ['--line-number', '--color', 'never', '--glob', '*.ts', '--', 'needle', 'src'],
        cwd: undefined,
        timeoutMs: 30_000,
      },
    ]);
    expect(result).toMatchObject({ ok: true, matches: ['src/app.ts:2:needle'] });
  });
});

describe('execution truth and redaction', () => {
  it('redacts stdout and stderr through the injected registry redactor', async () => {
    const runtime = new RecordingRuntime();
    runtime.execResult = {
      exitCode: 0,
      stdout: 'stdout raw-marker',
      stderr: 'stderr raw-marker',
      durationMs: 4,
      truncated: false,
    };

    await expect(
      registryFor(runtime).execute('run_command', { cmd: 'node', args: ['--version'] }),
    ).resolves.toMatchObject({
      ok: true,
      stdout: 'stdout [REDACTED]',
      stderr: 'stderr [REDACTED]',
    });
  });

  it('derives ok from exitCode and never trusts a caller or runtime success claim', async () => {
    const runtime = new RecordingRuntime();
    runtime.execResult = {
      exitCode: 7,
      stdout: '',
      stderr: 'command failed',
      durationMs: 3,
      truncated: false,
      ...({ ok: true } as { ok: true }),
    };
    const registry = registryFor(runtime);

    await expect(
      registry.execute('run_command', { cmd: 'node', args: ['missing.js'], ok: true }),
    ).rejects.toThrow();
    const output = await registry.execute('run_command', { cmd: 'node', args: ['missing.js'] });
    expect(output).toMatchObject({ ok: false, exitCode: 7 });
    expect(
      registry.get('run_command').userSummary({ cmd: 'node', args: ['missing.js'] }, output),
    ).toContain('failed');
  });

  it('redacts nested browser evidence fields before returning validated output', async () => {
    const browser: BrowserEvidencePort = {
      ...defaultPorts().browser,
      inspectConsole: () =>
        Promise.resolve({
          ok: true,
          entries: [{ level: 'error', message: 'raw-marker', timestamp: '2026-08-06T00:00:00Z' }],
        }),
    };

    await expect(
      registryFor(new RecordingRuntime(), { browser }).execute('inspect_browser_console', {
        ...attribution,
        sessionId: 'browser_session',
      }),
    ).resolves.toMatchObject({
      entries: [{ message: '[REDACTED]' }],
    });
  });
});

describe('git runtime boundary', () => {
  it('uses only the typed WorkspaceRuntime.git merge and revert operations', async () => {
    const runtime = new RecordingRuntime();
    const registry = registryFor(runtime);

    await registry.execute('merge_branch', { ref: 'feature/agent-tools' });
    await registry.execute('revert_commit', {
      commit: '0123456789abcdef0123456789abcdef01234567',
    });

    expect(runtime.gitCalls).toEqual([
      { operation: 'merge', ref: 'feature/agent-tools' },
      { operation: 'revert', commit: '0123456789abcdef0123456789abcdef01234567' },
    ]);
    await expect(registry.execute('merge_branch', { ref: '--strategy=ours' })).rejects.toThrow();
    await expect(registry.execute('revert_commit', { commit: 'HEAD' })).rejects.toThrow();
  });
});

describe('validated service ports', () => {
  it('reads the latest project contract through the tenant-aware port', async () => {
    const calls: unknown[] = [];
    const projectData: ProjectDataPort = {
      ...defaultPorts().projectData,
      readLatestProjectContract: (input) => {
        calls.push(input);
        return Promise.resolve({ ok: true, version: 9, contract });
      },
    };
    const result = await registryFor(new RecordingRuntime(), { projectData }).execute(
      'read_project_contract',
      attribution,
    );

    expect(calls).toEqual([attribution]);
    expect(result).toMatchObject({ ok: true, version: 9, contract });
  });

  it('retries a retryable read port failure and validates the eventual output', async () => {
    let attempts = 0;
    const projectData: ProjectDataPort = {
      ...defaultPorts().projectData,
      readLogs: () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error('temporary'));
        }
        return Promise.resolve({ ok: true, entries: [], truncated: false });
      },
    };

    await expect(
      registryFor(new RecordingRuntime(), { projectData }).execute('read_logs', {
        ...attribution,
        limit: 10,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(attempts).toBe(2);
  });

  it('passes an environment value only to its port and keeps summaries, audits, outputs, and errors clean', async () => {
    const received: unknown[] = [];
    const environment: EnvironmentPort = {
      setEnvironmentVariable: (input) => {
        received.push(input);
        return Promise.resolve({ ok: true, updated: true, name: 'CONFIG_VALUE', scope: 'preview' });
      },
    };
    const registry = registryFor(new RecordingRuntime(), { environment });
    const input = toolInputs.set_environment_variable;
    const output = await registry.execute('set_environment_variable', input);
    const definition = registry.get('set_environment_variable');

    expect(received).toEqual([input]);
    expect(JSON.stringify(output)).not.toContain('private-marker');
    expect(definition.userSummary(definition.inputSchema.parse(input), output)).not.toContain(
      'private-marker',
    );
    expect(
      JSON.stringify(definition.auditPayload(definition.inputSchema.parse(input), output)),
    ).not.toContain('private-marker');

    const failingEnvironment: EnvironmentPort = {
      setEnvironmentVariable: () => Promise.reject(new Error('private-marker')),
    };
    await expect(
      registryFor(new RecordingRuntime(), { environment: failingEnvironment }).execute(
        'set_environment_variable',
        input,
      ),
    ).rejects.not.toThrow('private-marker');
  });
});
