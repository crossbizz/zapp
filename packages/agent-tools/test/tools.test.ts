import { lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
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
  type WorkspaceRenameInput,
  type WorkspaceSearchInput,
  type WorkspaceRuntime,
} from '@zapp/workspace-runtime';
import { describe, expect, it, vi } from 'vitest';
import {
  ToolExecutionError,
  ToolRegistry,
  type BrowserEvidencePort,
  type EnvironmentPort,
  type MigrationPort,
  type OutputRedactor,
  type ProjectDataPort,
  type DeploymentHealthPort,
  type PreviewToolPort,
  type ReleasePort,
  type ToolRegistryDependencies,
} from '../src/registry.js';

async function rejectedToolExecution(promise: Promise<unknown>): Promise<ToolExecutionError> {
  try {
    await promise;
    throw new Error('Expected tool execution to reject');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ToolExecutionError);
    return error as ToolExecutionError;
  }
}

const attribution = {
  organizationId: 'org_test',
  projectId: 'project_test',
  runId: 'run_test',
  taskId: 'task_test',
} as const;

const trustedContext = {
  organizationId: 'org_trusted',
  projectId: 'project_trusted',
  runId: 'run_trusted',
  taskId: 'task_trusted',
  step: 'step-1',
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
  test: {
    unit: 'pnpm test',
    browser: 'pnpm test:browser',
    integration: 'pnpm test:integration',
  },
};

class RecordingRuntime implements WorkspaceRuntime {
  readonly kind = 'local' as const;
  readonly execCalls: Array<Parameters<WorkspaceRuntime['exec']>[0]> = [];
  readonly searchCalls: WorkspaceSearchInput[] = [];
  readonly deleteFileCalls: string[] = [];
  readonly renameFileCalls: WorkspaceRenameInput[] = [];
  readonly gitCalls: GitOp[] = [];
  readonly atomicWriteCalls: Array<readonly { path: string; data: Uint8Array }[]> = [];
  restartCalls = 0;
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

  async writeFilesAtomically(
    files: readonly { path: string; data: Uint8Array }[],
  ): Promise<void> {
    this.atomicWriteCalls.push(files);
    for (const file of files) {
      await this.writeFile(file.path, file.data);
    }
  }

  search(input: WorkspaceSearchInput): Promise<ExecResult> {
    this.searchCalls.push(input);
    return Promise.resolve(this.execResult);
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
    if (path === '.' || path === 'src') {
      return { path, type: 'directory', size: 0, mtimeMs: 1 };
    }
    const value = await this.readFile(path);
    return { path, type: 'file', size: value.byteLength, mtimeMs: 1 };
  }

  delete(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  deleteFile(path: string): Promise<void> {
    this.deleteFileCalls.push(path);
    if (!this.files.delete(path)) return Promise.reject(new Error(`Missing test file: ${path}`));
    return Promise.resolve();
  }

  renameFile(input: WorkspaceRenameInput): Promise<void> {
    this.renameFileCalls.push(input);
    if (input.source === input.destination) {
      return Promise.reject(new Error('source and destination must differ'));
    }
    const data = this.files.get(input.source);
    if (data === undefined) return Promise.reject(new Error(`Missing test file: ${input.source}`));
    this.files.set(input.destination, data);
    this.files.delete(input.source);
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

  restartDevServer(contractInput: ExecutionContract): Promise<{ port: number; pid: number }> {
    void contractInput;
    this.restartCalls += 1;
    return Promise.resolve({ port: 3000, pid: 84 });
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
        migrationId: 'migration_test',
        status: 'applied',
      }),
  };
  const environment: EnvironmentPort = {
    setEnvironmentVariable: () =>
      Promise.resolve({
        updated: true,
        name: 'CONFIG_VALUE',
        scope: 'preview',
      }),
  };
  const browser: BrowserEvidencePort = {
    runBrowserTests: () =>
      Promise.resolve({ passed: true, summary: 'Browser checks passed' }),
    captureScreenshot: () =>
      Promise.resolve({
        artifactId: 'artifact_screenshot',
        path: 'artifacts/home.png',
      }),
    inspectConsole: () => Promise.resolve({ entries: [] }),
    inspectNetwork: () => Promise.resolve({ requests: [] }),
  };
  const release: ReleasePort = {
    createReleaseCandidate: () =>
      Promise.resolve({
        id: 'release_test',
        status: 'candidate',
      }),
    getReadiness: () => Promise.resolve({ state: 'ready', findings: [] }),
    approve: () => Promise.resolve({ id: 'release_test', status: 'approved' }),
    deploy: () => Promise.resolve({ deploymentId: 'deployment_test' }),
    rollback: () => Promise.resolve({ deploymentId: 'deployment_rollback' }),
    getEvidence: () => Promise.resolve({ releaseId: 'release_test', artifacts: [] }),
  };
  const preview: PreviewToolPort = {
    createPreview: () =>
      Promise.resolve({ previewId: 'preview_test', url: 'https://preview.example.test' }),
    runPreviewSmokeTest: () => Promise.resolve({ passed: true, summary: 'Preview healthy' }),
  };
  const deploymentHealth: DeploymentHealthPort = {
    checkDeploymentHealth: () => Promise.resolve({ healthy: true, details: 'healthy' }),
  };
  return {
    redactor,
    projectData,
    migrations,
    environment,
    browser,
    release,
    preview,
    deploymentHealth,
  };
}

function registryFor(
  runtime: WorkspaceRuntime,
  overrides: Partial<Omit<ToolRegistryDependencies, 'runtime'>> = {},
): ToolRegistry {
  return new ToolRegistry({ runtime, ...defaultPorts(), ...overrides });
}

async function withMemoryRegistry(
  run: (runtime: MemoryWorkspaceRuntime, registry: ToolRegistry, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'zapp-agent-tools-'));
  const runtime = new MemoryWorkspaceRuntime(root);
  try {
    await run(runtime, registryFor(runtime), root);
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
  read_logs: { limit: 50 },
  read_test_results: { suite: 'unit' },
  read_database_schema: { environmentId: 'environment_test' },
  read_project_contract: {},
  write_file: { path: 'written.txt', content: 'written' },
  apply_patch: {
    patch: '--- a/source.txt\n+++ b/source.txt\n@@ -1,1 +1,1 @@\n-source\n+updated\n',
  },
  copy_file: { source: 'source.txt', destination: 'copied.txt' },
  rename_file: { source: 'rename.txt', destination: 'renamed.txt' },
  delete_file: { path: 'delete.txt' },
  install_dependency: { packageManager: 'pnpm', packages: ['zod'], dev: false },
  execute_migration: {
    environmentId: 'environment_test',
    migration: 'CREATE TABLE sample (id text)',
  },
  set_environment_variable: {
    environmentId: 'environment_test',
    name: 'CONFIG_VALUE',
    secretRef: 'sec_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
    scope: 'preview',
  },
  run_command: { cmd: 'node', args: ['--version'] },
  run_dev_server: {},
  restart_dev_server: {},
  run_build: {},
  run_typecheck: {},
  run_lint: {},
  run_unit_tests: {},
  run_integration_tests: {},
  run_browser_tests: { previewId: 'preview_test', route: '/' },
  capture_screenshot: {
    previewId: 'preview_test',
    route: '/',
    name: 'home',
  },
  inspect_browser_console: { previewId: 'preview_test', route: '/' },
  inspect_network_requests: { previewId: 'preview_test', route: '/' },
  create_branch: { name: 'feature/agent-tools' },
  create_checkpoint: { paths: ['source.txt'], message: 'checkpoint' },
  commit_changes: { paths: ['source.txt'], message: 'change' },
  restore_file: { path: 'source.txt' },
  revert_commit: { commit: '0123456789abcdef0123456789abcdef01234567' },
  merge_branch: { ref: 'feature/agent-tools' },
  create_preview: { branchId: 'branch_test', commitSha: '0123456789abcdef' },
  run_preview_smoke_test: { previewId: 'preview_test' },
  create_release_candidate: {
    environmentId: 'environment_test',
    commitSha: '0123456789abcdef',
    specificationId: 'specification_test',
  },
  deploy_release: {
    releaseId: 'release_test',
    deploymentType: 'redeploy',
  },
  check_deployment_health: { deploymentId: 'deployment_test' },
  rollback_release: {
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
      expect(typeof definition.executeWithAudit).toBe('function');

      const input = toolInputs[name];
      expect(definition.inputSchema.safeParse(input).success).toBe(true);
      expect(
        definition.inputSchema.safeParse({ ...(input as object), unexpected: true }).success,
      ).toBe(false);
      const output = await definition.execute(input, trustedContext);
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
      await expect(
        registry.execute('read_file', { path: '../outside' }, trustedContext),
      ).rejects.toBeInstanceOf(PathViolationError);
    });
  });

  it('applies a unified patch atomically and reports patch_conflict without a partial write', async () => {
    await withMemoryRegistry(async (runtime, registry) => {
      await runtime.writeFile('app.ts', new TextEncoder().encode('first\nsecond\nthird\n'));
      await expect(
        registry.execute('apply_patch', {
          patch: '--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,3 @@\n first\n-second\n+changed\n third\n',
        }, trustedContext),
      ).resolves.toMatchObject({ ok: true, filesChanged: 1, hunksApplied: 1 });
      await expect(runtime.readFile('app.ts')).resolves.toEqual(
        new TextEncoder().encode('first\nchanged\nthird\n'),
      );

      const conflict = await registry.execute('apply_patch', {
        patch:
          '--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,3 @@\n first\n-missing-context\n+wrong\n third\n',
      }, trustedContext);
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
        }, trustedContext),
      ).resolves.toMatchObject({ ok: false, error: { code: 'patch_conflict' } });
      await expect(runtime.readFile('first.txt')).resolves.toEqual(
        new TextEncoder().encode('first\n'),
      );
      await expect(runtime.readFile('second.txt')).resolves.toEqual(
        new TextEncoder().encode('second\n'),
      );
    });
  });

  it('rejects two patch sections that resolve to one file without losing either edit', async () => {
    await withMemoryRegistry(async (runtime, registry) => {
      await runtime.writeFile('file.txt', new TextEncoder().encode('one\ntwo\n'));

      await expect(
        registry.execute(
          'apply_patch',
          {
            patch:
              '--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n--- a/./file.txt\n+++ b/./file.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n',
          },
          trustedContext,
        ),
      ).rejects.toThrow();
      await expect(runtime.readFile('file.txt')).resolves.toEqual(
        new TextEncoder().encode('one\ntwo\n'),
      );
    });
  });

  it('rejects apply_patch to a leaf symlink without replacing it or changing its referent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-agent-tools-leaf-symlink-'));
    const referent = join(root, 'referent.txt');
    const leaf = join(root, 'leaf.txt');
    await writeFile(referent, 'before\n');
    await symlink('referent.txt', leaf, 'file');
    const registry = registryFor(new MemoryWorkspaceRuntime(root));

    try {
      await expect(
        registry.execute(
          'apply_patch',
          {
            patch:
              '--- a/leaf.txt\n+++ b/leaf.txt\n@@ -1,1 +1,1 @@\n-before\n+after\n',
          },
          trustedContext,
        ),
      ).rejects.toMatchObject({ code: 'tool_failed' });
      expect((await lstat(leaf)).isSymbolicLink()).toBe(true);
      expect(await readlink(leaf)).toBe('referent.txt');
      expect(await readFile(referent, 'utf8')).toBe('before\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs search_code through one typed WorkspaceRuntime search call', async () => {
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
    }, trustedContext);

    expect(runtime.searchCalls).toEqual([
      {
        pattern: 'needle',
        path: 'src',
        glob: '*.ts',
      },
    ]);
    expect(runtime.execCalls).toEqual([]);
    expect(result).toMatchObject({ ok: true, matches: ['src/app.ts:2:needle'] });
  });

  it('does not expose search_code or grep to a stat-then-exec path swap', async () => {
    class RacingSearchRuntime extends RecordingRuntime {
      override stat(path: string): Promise<FileStat> {
        return Promise.resolve({ path, type: 'file', size: 1, mtimeMs: 1 });
      }

      override exec(input: Parameters<WorkspaceRuntime['exec']>[0]): Promise<ExecResult> {
        this.execCalls.push(input);
        return Promise.resolve({
          exitCode: 0,
          stdout: '1:outside marker\n',
          stderr: '',
          durationMs: 1,
          truncated: false,
        });
      }

      override search(input: WorkspaceSearchInput): Promise<ExecResult> {
        this.searchCalls.push(input);
        return Promise.resolve({
          exitCode: 1,
          stdout: '',
          stderr: '',
          durationMs: 1,
          truncated: false,
        });
      }
    }

    for (const [name, input] of [
      ['search_code', { query: 'outside', path: 'target' }],
      ['grep', { pattern: 'outside', path: 'target' }],
    ] as const) {
      const runtime = new RacingSearchRuntime();
      await expect(registryFor(runtime).execute(name, input, trustedContext)).resolves.toMatchObject({
        ok: true,
        matches: [],
      });
      expect(runtime.searchCalls).toHaveLength(1);
      expect(runtime.execCalls).toEqual([]);
    }
  });

  it('rejects absolute, parent, and symlink-escape paths for search_code and grep', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'zapp-agent-tools-outside-'));
    const outsideFile = join(outside, 'outside.txt');
    await writeFile(outsideFile, 'outside marker');

    try {
      await withMemoryRegistry(async (_runtime, registry, root) => {
        await symlink(outside, join(root, 'escape'));
        for (const name of ['search_code', 'grep'] as const) {
          for (const path of [outsideFile, '../outside.txt', 'escape/outside.txt']) {
            const modelInput =
              name === 'search_code'
                ? { query: 'outside', path }
                : { pattern: 'outside', path };
            await expect(registry.execute(name, modelInput, trustedContext)).rejects.toBeInstanceOf(
              PathViolationError,
            );
          }
        }
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects delete_file for workspace roots and directories before runtime deletion', async () => {
    class GuardedDeleteRuntime extends RecordingRuntime {
      readonly deleted: string[] = [];

      override stat(path: string): Promise<FileStat> {
        return Promise.resolve({ path, type: 'directory', size: 0, mtimeMs: 1 });
      }

      override delete(path: string): Promise<void> {
        this.deleted.push(path);
        return Promise.resolve();
      }
    }

    for (const path of ['.', './', 'directory']) {
      const runtime = new GuardedDeleteRuntime();
      await expect(
        registryFor(runtime).execute('delete_file', { path }, trustedContext),
      ).rejects.toThrow();
      expect(runtime.deleted).toEqual([]);
    }
  });

  it('cannot recursively delete a directory swapped in after a file check', async () => {
    class RacingDeleteRuntime extends RecordingRuntime {
      directoryDeleted = false;

      override stat(path: string): Promise<FileStat> {
        return Promise.resolve({ path, type: 'file', size: 1, mtimeMs: 1 });
      }

      override delete(): Promise<void> {
        this.directoryDeleted = true;
        return Promise.resolve();
      }

      override deleteFile(path: string): Promise<void> {
        this.deleteFileCalls.push(path);
        return Promise.reject(Object.assign(new Error('is a directory'), { code: 'EISDIR' }));
      }
    }

    const runtime = new RacingDeleteRuntime();
    await expect(
      registryFor(runtime).execute('delete_file', { path: 'victim' }, trustedContext),
    ).rejects.toThrow();
    expect(runtime.deleteFileCalls).toEqual(['victim']);
    expect(runtime.directoryDeleted).toBe(false);
  });

  it('returns success when delete_file is repeated after an already-completed deletion', async () => {
    await withMemoryRegistry(async (runtime, registry) => {
      await runtime.writeFile('repeat-delete.txt', new TextEncoder().encode('delete me'));

      await expect(
        registry.execute('delete_file', { path: 'repeat-delete.txt' }, trustedContext),
      ).resolves.toEqual({ ok: true, path: 'repeat-delete.txt' });
      await expect(
        registry.execute('delete_file', { path: 'repeat-delete.txt' }, trustedContext),
      ).resolves.toEqual({ ok: true, path: 'repeat-delete.txt' });
    });
  });

  it('rejects a resolved self-rename without deleting the source file', async () => {
    await withMemoryRegistry(async (runtime, registry) => {
      await runtime.writeFile('same.txt', new TextEncoder().encode('same'));

      await expect(
        registry.execute(
          'rename_file',
          { source: 'same.txt', destination: './same.txt' },
          trustedContext,
        ),
      ).rejects.toThrow();
      await expect(runtime.readFile('same.txt')).resolves.toEqual(new TextEncoder().encode('same'));
    });
  });

  it('treats ripgrep exit 1 as a successful search with no matches', async () => {
    const runtime = new RecordingRuntime();
    runtime.execResult = {
      exitCode: 1,
      stdout: '',
      stderr: '',
      durationMs: 2,
      truncated: false,
    };

    await expect(
      registryFor(runtime).execute(
        'search_code',
        { query: 'absent', path: 'source.txt' },
        trustedContext,
      ),
    ).resolves.toMatchObject({ ok: true, exitCode: 1, matches: [] });
  });
});

describe('execution truth and redaction', () => {
  it('persists redacted canonical command identity with trusted caller attribution', async () => {
    const runtime = new RecordingRuntime();
    const registeredSecret = 'api"key\\line\nnext';
    const redactor: OutputRedactor = {
      redact: (value) => value.split(registeredSecret).join('[secret:API_KEY]'),
    };
    const contractedCommand = `pnpm build --token ${registeredSecret}`;
    const projectData: ProjectDataPort = {
      ...defaultPorts().projectData,
      readLatestProjectContract: () =>
        Promise.resolve({
          ok: true,
          version: 9,
          contract: { ...contract, build: { command: contractedCommand } },
        }),
    };
    const registry = registryFor(runtime, { redactor, projectData });

    const first = await registry.executeWithAudit(
      'run_command',
      { cmd: 'node', args: ['--version'], cwd: 'src' },
      trustedContext,
    );
    const second = await registry.executeWithAudit(
      'run_command',
      { cmd: 'bun', args: ['--version'], cwd: 'src' },
      trustedContext,
    );
    expect(first.context).toEqual(trustedContext);
    expect(first.auditPayload).toMatchObject({
      organizationId: 'org_trusted',
      projectId: 'project_trusted',
      runId: 'run_trusted',
      taskId: 'task_trusted',
      step: 'step-1',
      tool: 'run_command',
      command: 'node',
      argument0: '--version',
      argumentCount: 1,
      cwd: 'src',
      outcome: 'succeeded',
      code: 'ok',
      attemptCount: 1,
    });
    expect(second.auditPayload.command).toBe('bun');
    expect(second.auditPayload.command).not.toBe(first.auditPayload.command);

    const secretBearing = await registry.executeWithAudit(
      'run_command',
      { cmd: 'node', args: ['--token', registeredSecret] },
      trustedContext,
    );
    expect(secretBearing.auditPayload).toMatchObject({
      argument0: '--token',
      argument1: '[secret:API_KEY]',
      argumentCount: 2,
    });
    expect(secretBearing.auditPayload).not.toHaveProperty('arguments');
    expect(Object.values(secretBearing.auditPayload)).not.toContain(registeredSecret);

    const named = await registry.executeWithAudit('run_build', {}, trustedContext);
    expect(named.context).toEqual(trustedContext);
    expect(named.auditPayload).toMatchObject({
      contractVersion: 9,
      command: 'pnpm build --token [secret:API_KEY]',
      cwd: '.',
      tool: 'run_build',
      outcome: 'succeeded',
      code: 'ok',
      attemptCount: 1,
    });
    expect(Object.values(named.auditPayload)).not.toContain(registeredSecret);
  });

  it('carries redacted attempt audits for arbitrary and named command transport rejection', async () => {
    const registeredSecret = 'transport"secret\\path\nline';
    class RejectingRuntime extends RecordingRuntime {
      override exec(input: Parameters<WorkspaceRuntime['exec']>[0]): Promise<ExecResult> {
        this.execCalls.push(input);
        return Promise.reject(new Error(`transport exposed ${registeredSecret}`));
      }
    }
    const runtime = new RejectingRuntime();
    const projectData: ProjectDataPort = {
      ...defaultPorts().projectData,
      readLatestProjectContract: () =>
        Promise.resolve({
          ok: true,
          version: 11,
          contract: {
            ...contract,
            build: { command: `pnpm build --token ${registeredSecret}` },
          },
        }),
    };
    const registry = registryFor(runtime, {
      projectData,
      redactor: {
        redact: (value) => value.split(registeredSecret).join('[secret:TRANSPORT_KEY]'),
      },
    });

    const arbitrary = await rejectedToolExecution(
      registry.executeWithAudit(
        'run_command',
        { cmd: 'node', args: ['--token', registeredSecret], cwd: 'src' },
        trustedContext,
      ),
    );
    expect(arbitrary.message).toBe('run_command failed');
    expect(arbitrary.context).toEqual(trustedContext);
    expect(arbitrary.auditPayload).toMatchObject({
      organizationId: 'org_trusted',
      projectId: 'project_trusted',
      runId: 'run_trusted',
      taskId: 'task_trusted',
      step: 'step-1',
      tool: 'run_command',
      command: 'node',
      argument0: '--token',
      argument1: '[secret:TRANSPORT_KEY]',
      argumentCount: 2,
      cwd: 'src',
      outcome: 'failed',
      code: 'tool_failed',
      attemptCount: 1,
    });
    expect(Object.values(arbitrary.auditPayload)).not.toContain(registeredSecret);

    const named = await rejectedToolExecution(
      registry.executeWithAudit('run_build', {}, trustedContext),
    );
    expect(named.message).toBe('run_build failed');
    expect(named.context).toEqual(trustedContext);
    expect(named.auditPayload).toMatchObject({
      tool: 'run_build',
      contractVersion: 11,
      command: 'pnpm build --token [secret:TRANSPORT_KEY]',
      cwd: '.',
      outcome: 'failed',
      code: 'tool_failed',
      attemptCount: 1,
    });
    expect(Object.values(named.auditPayload)).not.toContain(registeredSecret);
    expect(runtime.execCalls).toHaveLength(2);
  });

  it('carries attempt audits when arbitrary and named commands time out', async () => {
    vi.useFakeTimers();
    class PendingRuntime extends RecordingRuntime {
      override exec(input: Parameters<WorkspaceRuntime['exec']>[0]): Promise<ExecResult> {
        this.execCalls.push(input);
        return new Promise(() => undefined);
      }
    }
    const runtime = new PendingRuntime();
    const registry = registryFor(runtime);

    try {
      const arbitraryExecution = registry.executeWithAudit(
        'run_command',
        { cmd: 'node', args: ['slow.js'], cwd: 'src' },
        trustedContext,
      );
      const arbitraryFailure = rejectedToolExecution(arbitraryExecution);
      await vi.advanceTimersByTimeAsync(120_001);
      const arbitrary = await arbitraryFailure;
      expect(arbitrary.context).toEqual(trustedContext);
      expect(arbitrary.auditPayload).toMatchObject({
        tool: 'run_command',
        command: 'node',
        argument0: 'slow.js',
        argumentCount: 1,
        cwd: 'src',
        outcome: 'timed_out',
        code: 'tool_timeout',
        attemptCount: 1,
      });

      const namedExecution = registry.executeWithAudit('run_build', {}, trustedContext);
      const namedFailure = rejectedToolExecution(namedExecution);
      await vi.advanceTimersByTimeAsync(120_001);
      const named = await namedFailure;
      expect(named.context).toEqual(trustedContext);
      expect(named.auditPayload).toMatchObject({
        tool: 'run_build',
        contractVersion: 3,
        command: 'pnpm build',
        cwd: '.',
        outcome: 'timed_out',
        code: 'tool_timeout',
        attemptCount: 1,
      });
      expect(runtime.execCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries attempt audits and dispatches no retry after in-flight command cancellation', async () => {
    class PendingRuntime extends RecordingRuntime {
      override exec(input: Parameters<WorkspaceRuntime['exec']>[0]): Promise<ExecResult> {
        this.execCalls.push(input);
        return new Promise(() => undefined);
      }
    }
    const runtime = new PendingRuntime();
    const registry = registryFor(runtime);

    const arbitraryCaller = new AbortController();
    const arbitraryExecution = registry.executeWithAudit(
      'run_command',
      { cmd: 'node', args: ['watch.js'], cwd: 'src' },
      trustedContext,
      arbitraryCaller.signal,
    );
    const arbitraryFailure = rejectedToolExecution(arbitraryExecution);
    await vi.waitFor(() => {
      expect(runtime.execCalls).toHaveLength(1);
    });
    arbitraryCaller.abort(new Error('stop arbitrary command'));
    const arbitrary = await arbitraryFailure;
    expect(arbitrary.context).toEqual(trustedContext);
    expect(arbitrary.auditPayload).toMatchObject({
      tool: 'run_command',
      command: 'node',
      argument0: 'watch.js',
      cwd: 'src',
      outcome: 'cancelled',
      code: 'tool_cancelled',
      attemptCount: 1,
    });

    const namedCaller = new AbortController();
    const namedExecution = registry.executeWithAudit(
      'run_build',
      {},
      trustedContext,
      namedCaller.signal,
    );
    const namedFailure = rejectedToolExecution(namedExecution);
    await vi.waitFor(() => {
      expect(runtime.execCalls).toHaveLength(2);
    });
    namedCaller.abort(new Error('stop named command'));
    const named = await namedFailure;
    expect(named.context).toEqual(trustedContext);
    expect(named.auditPayload).toMatchObject({
      tool: 'run_build',
      contractVersion: 3,
      command: 'pnpm build',
      cwd: '.',
      outcome: 'cancelled',
      code: 'tool_cancelled',
      attemptCount: 1,
    });
    expect(runtime.execCalls).toHaveLength(2);
  });

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
      registryFor(runtime).execute(
        'run_command',
        { cmd: 'node', args: ['--version'] },
        trustedContext,
      ),
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
      registry.execute(
        'run_command',
        { cmd: 'node', args: ['missing.js'], ok: true },
        trustedContext,
      ),
    ).rejects.toThrow();
    const output = await registry.execute(
      'run_command',
      { cmd: 'node', args: ['missing.js'] },
      trustedContext,
    );
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
          entries: [{ level: 'error', message: 'raw-marker', timestamp: '2026-08-06T00:00:00Z' }],
        }),
    };

    await expect(
      registryFor(new RecordingRuntime(), { browser }).execute(
        'inspect_browser_console',
        { previewId: 'preview_test', route: '/' },
        trustedContext,
      ),
    ).resolves.toMatchObject({
      entries: [{ message: '[REDACTED]' }],
    });
  });
});

describe('git runtime boundary', () => {
  it('uses only the typed WorkspaceRuntime.git merge and revert operations', async () => {
    const runtime = new RecordingRuntime();
    const registry = registryFor(runtime);

    await registry.execute('merge_branch', { ref: 'feature/agent-tools' }, trustedContext);
    await registry.execute('revert_commit', {
      commit: '0123456789abcdef0123456789abcdef01234567',
    }, trustedContext);

    expect(runtime.gitCalls).toEqual([
      { operation: 'merge', ref: 'feature/agent-tools' },
      { operation: 'revert', commit: '0123456789abcdef0123456789abcdef01234567' },
    ]);
    await expect(
      registry.execute('merge_branch', { ref: '--strategy=ours' }, trustedContext),
    ).rejects.toThrow();
    await expect(
      registry.execute('revert_commit', { commit: 'HEAD' }, trustedContext),
    ).rejects.toThrow();
  });

  it('rejects a git_show option where an object ref is required', () => {
    const definition = registryFor(new RecordingRuntime()).get('git_show');
    expect(definition.inputSchema.safeParse({ ref: '--stat' }).success).toBe(false);
  });
});

describe('validated service ports', () => {
  it('injects trusted attribution separately and rejects model override fields', async () => {
    const calls: unknown[] = [];
    const projectData: ProjectDataPort = {
      ...defaultPorts().projectData,
      readLatestProjectContract: (input) => {
        calls.push(input);
        return Promise.resolve({ ok: true, version: 9, contract });
      },
    };
    const registry = registryFor(new RecordingRuntime(), { projectData });

    await registry.execute('read_project_contract', {}, trustedContext);
    expect(calls).toEqual([trustedContext]);
    await expect(
      registry.execute(
        'read_project_contract',
        { organizationId: 'org_override' },
        trustedContext,
      ),
    ).rejects.toThrow();
  });

  it('keeps plaintext environment values and command environments out of model schemas', () => {
    const registry = registryFor(new RecordingRuntime());
    expect(
      registry.get('set_environment_variable').inputSchema.safeParse({
        ...attribution,
        environmentId: 'environment_test',
        idempotencyKey: 'model-key',
        name: 'CONFIG_VALUE',
        value: 'plaintext-marker',
        scope: 'preview',
      }).success,
    ).toBe(false);
    expect(
      registry.get('set_environment_variable').inputSchema.safeParse({
        environmentId: 'environment_test',
        name: 'CONFIG_VALUE',
        secretRef: 'sec_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
        scope: 'preview',
      }).success,
    ).toBe(true);
    expect(
      registry.get('set_environment_variable').inputSchema.safeParse({
        environmentId: 'environment_test',
        name: 'CONFIG_VALUE',
        secretRef: 'plaintext-marker',
        scope: 'preview',
      }).success,
    ).toBe(false);
    expect(
      registry.get('run_command').inputSchema.safeParse({
        cmd: 'node',
        args: ['--version'],
        env: { CONFIG_VALUE: 'plaintext-marker' },
      }).success,
    ).toBe(false);
  });

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
      {},
      trustedContext,
    );

    expect(calls).toEqual([trustedContext]);
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
      registryFor(new RecordingRuntime(), { projectData }).execute(
        'read_logs',
        { limit: 10 },
        trustedContext,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(attempts).toBe(2);
  });

  it('passes only an opaque secret reference to its port and keeps summaries, audits, outputs, and errors clean', async () => {
    const received: unknown[] = [];
    const environment: EnvironmentPort = {
      setEnvironmentVariable: (input) => {
        received.push(input);
        return Promise.resolve({ updated: true, name: 'CONFIG_VALUE', scope: 'preview' });
      },
    };
    const registry = registryFor(new RecordingRuntime(), { environment });
    const input = toolInputs.set_environment_variable;
    const output = await registry.execute('set_environment_variable', input, trustedContext);
    const definition = registry.get('set_environment_variable');

    expect(received).toEqual([input]);
    expect(JSON.stringify(output)).not.toContain('sec_01J8ME7YQZJ2V9Q0X3T5B6K7ND');
    expect(definition.userSummary(definition.inputSchema.parse(input), output)).not.toContain(
      'sec_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
    );
    expect(
      JSON.stringify(definition.auditPayload(definition.inputSchema.parse(input), output)),
    ).not.toContain('sec_01J8ME7YQZJ2V9Q0X3T5B6K7ND');

    const failingEnvironment: EnvironmentPort = {
      setEnvironmentVariable: () => Promise.reject(new Error('private-marker')),
    };
    await expect(
      registryFor(new RecordingRuntime(), { environment: failingEnvironment }).execute(
        'set_environment_variable',
        input,
        trustedContext,
      ),
    ).rejects.not.toThrow('private-marker');
  });
});

describe('review round 1 safety regressions', () => {
  it('applies a multi-file patch through one atomic runtime batch without partial writes on first, middle, or final failure', async () => {
    const patch =
      '--- a/first.txt\n+++ b/first.txt\n@@ -1,1 +1,1 @@\n-first\n+changed-first\n' +
      '--- a/second.txt\n+++ b/second.txt\n@@ -1,1 +1,1 @@\n-second\n+changed-second\n' +
      '--- a/third.txt\n+++ b/third.txt\n@@ -1,1 +1,1 @@\n-third\n+changed-third\n';

    for (const failAt of [0, 1, 2]) {
      class FailingBatchRuntime extends RecordingRuntime {
        private writes = 0;

        constructor() {
          super();
          this.files.set('first.txt', new TextEncoder().encode('first\n'));
          this.files.set('second.txt', new TextEncoder().encode('second\n'));
          this.files.set('third.txt', new TextEncoder().encode('third\n'));
        }

        override writeFile(path: string, data: Uint8Array): Promise<void> {
          if (this.writes === failAt) {
            return Promise.reject(new Error(`injected write ${String(failAt)}`));
          }
          this.writes += 1;
          return super.writeFile(path, data);
        }

        override writeFilesAtomically(
          files: readonly { path: string; data: Uint8Array }[],
        ): Promise<void> {
          this.atomicWriteCalls.push(files);
          const staged: Array<{ path: string; data: Uint8Array }> = [];
          for (const [index, file] of files.entries()) {
            if (index === failAt) {
              return Promise.reject(new Error(`injected atomic write ${String(failAt)}`));
            }
            staged.push(file);
          }
          for (const file of staged) {
            this.files.set(file.path, file.data);
          }
          return Promise.resolve();
        }
      }

      const runtime = new FailingBatchRuntime();
      await expect(
        registryFor(runtime).execute('apply_patch', { patch }, trustedContext),
      ).rejects.toThrow();
      expect(runtime.atomicWriteCalls).toHaveLength(1);
      expect(new TextDecoder().decode(runtime.files.get('first.txt'))).toBe('first\n');
      expect(new TextDecoder().decode(runtime.files.get('second.txt'))).toBe('second\n');
      expect(new TextDecoder().decode(runtime.files.get('third.txt'))).toBe('third\n');
    }
  });

  it('uses the runtime restart primitive instead of starting another development server', async () => {
    class RestartRuntime extends RecordingRuntime {
      startCalls = 0;

      override startDevServer(
        contractInput: ExecutionContract,
      ): Promise<{ port: number; pid: number }> {
        void contractInput;
        this.startCalls += 1;
        return Promise.resolve({ port: 3000, pid: 42 });
      }
    }
    const runtime = new RestartRuntime();

    await expect(
      registryFor(runtime).execute('restart_dev_server', {}, trustedContext),
    ).resolves.toMatchObject({ ok: true, pid: 84 });
    expect(runtime.restartCalls).toBe(1);
    expect(runtime.startCalls).toBe(0);
  });

  it('binds every named command to the latest validated execution contract and rejects command overrides', async () => {
    const runtime = new RecordingRuntime();
    const projectData: ProjectDataPort = {
      ...defaultPorts().projectData,
      readLatestProjectContract: () => Promise.resolve({ ok: true, version: 9, contract }),
    };
    const registry = registryFor(runtime, { projectData });

    await expect(registry.execute('run_build', {}, trustedContext)).resolves.toMatchObject({
      ok: true,
    });
    expect(runtime.execCalls).toEqual([
      {
        cmd: 'sh',
        args: ['-lc', contract.build?.command],
        cwd: contract.workspace_root,
        timeoutMs: 120_000,
      },
    ]);
    await expect(
      registry.execute(
        'run_build',
        { cmd: 'node', args: ['malicious.js'] },
        trustedContext,
      ),
    ).rejects.toThrow();

    runtime.execCalls.length = 0;
    await expect(
      registry.execute('run_integration_tests', {}, trustedContext),
    ).resolves.toMatchObject({ ok: true, exitCode: 0 });
    expect(runtime.execCalls).toEqual([
      {
        cmd: 'sh',
        args: ['-lc', contract.test?.integration],
        cwd: contract.workspace_root,
        timeoutMs: 120_000,
      },
    ]);

    const withoutIntegration: ExecutionContract = {
      ...contract,
      test: { unit: 'pnpm test', browser: 'pnpm test:browser' },
    };
    const missingProjectData: ProjectDataPort = {
      ...projectData,
      readLatestProjectContract: () =>
        Promise.resolve({ ok: true, version: 10, contract: withoutIntegration }),
    };
    await expect(
      registryFor(runtime, { projectData: missingProjectData }).execute(
        'run_integration_tests',
        {},
        trustedContext,
      ),
    ).resolves.toMatchObject({ ok: false, exitCode: 2 });
  });

  it('accepts only attributed browser targets with relative routes and rejects absolute or protocol-relative input', () => {
    const registry = registryFor(new RecordingRuntime());
    const browserInputs = [
      ['run_browser_tests', { previewId: 'preview_test', route: '/checks' }],
      [
        'capture_screenshot',
        { deploymentId: 'deployment_test', route: '/home', name: 'home' },
      ],
      ['inspect_browser_console', { previewId: 'preview_test', route: '/' }],
      ['inspect_network_requests', { deploymentId: 'deployment_test', route: '/requests' }],
    ] as const;

    for (const [name, input] of browserInputs) {
      expect(registry.get(name).inputSchema.safeParse(input).success).toBe(true);
      for (const route of [
        'http://169.254.169.254/latest/meta-data',
        'http://127.0.0.1:1/admin',
        '//169.254.169.254/latest/meta-data',
      ]) {
        expect(registry.get(name).inputSchema.safeParse({ ...input, route }).success).toBe(false);
      }
      expect(
        registry.get(name).inputSchema.safeParse({ ...input, baseUrl: 'http://127.0.0.1' })
          .success,
      ).toBe(false);
      expect(
        registry.get(name).inputSchema.safeParse({ ...input, url: 'http://127.0.0.1' }).success,
      ).toBe(false);
    }
  });

  it('passes the latest contracted browser command and trusted mutation context to the browser port', async () => {
    const calls: unknown[] = [];
    const browser: BrowserEvidencePort = {
      ...defaultPorts().browser,
      runBrowserTests: (input, context, signal) => {
        calls.push({ input, context, aborted: signal.aborted });
        return Promise.resolve({ passed: true, summary: 'browser passed' });
      },
    };

    await registryFor(new RecordingRuntime(), { browser }).execute(
      'run_browser_tests',
      { previewId: 'preview_test', route: '/checks' },
      trustedContext,
    );
    expect(calls).toEqual([
      {
        input: {
          previewId: 'preview_test',
          route: '/checks',
          command: 'pnpm test:browser',
          workspaceRoot: '.',
        },
        context: {
          ...trustedContext,
          idempotencyKey: 'run_trusted:task_trusted:step-1:run_browser_tests',
        },
        aborted: false,
      },
    ]);
  });

  it('derives failed migration, browser, smoke, and health envelopes from their status fields', async () => {
    const migrations: MigrationPort = {
      executeMigration: () =>
        Promise.resolve({ migrationId: 'migration_test', status: 'rejected', reason: 'blocked' }),
    };
    const browser: BrowserEvidencePort = {
      ...defaultPorts().browser,
      runBrowserTests: () => Promise.resolve({ passed: false, summary: 'failed checks' }),
    };
    const preview = {
      ...defaultPorts().preview,
      runPreviewSmokeTest: () => Promise.resolve({ passed: false, summary: 'smoke failed' }),
    };
    const deploymentHealth = {
      ...defaultPorts().deploymentHealth,
      checkDeploymentHealth: () =>
        Promise.resolve({ healthy: false, details: 'health failed' }),
    };
    const registry = registryFor(new RecordingRuntime(), {
      migrations,
      browser,
      preview,
      deploymentHealth,
    });

    await expect(
      registry.execute('execute_migration', toolInputs.execute_migration, trustedContext),
    ).resolves.toMatchObject({ ok: false, status: 'rejected' });
    await expect(
      registry.execute(
        'run_browser_tests',
        { previewId: 'preview_test', route: '/' },
        trustedContext,
      ),
    ).resolves.toMatchObject({ ok: false, passed: false });
    await expect(
      registry.execute('run_preview_smoke_test', { previewId: 'preview_test' }, trustedContext),
    ).resolves.toMatchObject({ ok: false, passed: false });
    await expect(
      registry.execute(
        'check_deployment_health',
        { deploymentId: 'deployment_test' },
        trustedContext,
      ),
    ).resolves.toMatchObject({ ok: false, healthy: false });
  });

  it('derives a failed test-result envelope from the trusted status field', async () => {
    const projectData: ProjectDataPort = {
      ...defaultPorts().projectData,
      readTestResults: () =>
        Promise.resolve({ status: 'failed', summary: 'unit failures', artifactId: 'artifact_tests' }),
    };

    await expect(
      registryFor(new RecordingRuntime(), { projectData }).execute(
        'read_test_results',
        { suite: 'unit' },
        trustedContext,
      ),
    ).resolves.toMatchObject({ ok: false, status: 'failed' });
  });

  it('exports the Plan 07 ReleasePort method set and maps release tools through narrow adapters', async () => {
    const calls: unknown[] = [];
    const release: ReleasePort = {
      createReleaseCandidate: (input) => {
        calls.push(input);
        return Promise.resolve({ id: 'release_test', status: 'candidate' });
      },
      getReadiness: () => Promise.resolve({ state: 'ready', findings: [] }),
      approve: () => Promise.resolve({ id: 'release_test', status: 'approved' }),
      deploy: () => Promise.resolve({ deploymentId: 'deployment_test' }),
      rollback: (input) => {
        calls.push(input);
        return Promise.resolve({ deploymentId: 'deployment_rollback' });
      },
      getEvidence: () => Promise.resolve({ releaseId: 'release_test', artifacts: [] }),
    };
    const preview: PreviewToolPort = {
      createPreview: () =>
        Promise.resolve({ previewId: 'preview_test', url: 'https://preview.example.test' }),
      runPreviewSmokeTest: () => Promise.resolve({ passed: true, summary: 'healthy' }),
    };
    const deploymentHealth: DeploymentHealthPort = {
      checkDeploymentHealth: () => Promise.resolve({ healthy: true, details: 'healthy' }),
    };
    const registry = new ToolRegistry({
      runtime: new RecordingRuntime(),
      ...defaultPorts(),
      release,
      preview,
      deploymentHealth,
    });

    await expect(
      registry.execute('create_release_candidate', toolInputs.create_release_candidate, trustedContext),
    ).resolves.toMatchObject({ ok: true, releaseId: 'release_test' });
    expect(Object.keys(release).sort()).toEqual(
      ['approve', 'createReleaseCandidate', 'deploy', 'getEvidence', 'getReadiness', 'rollback'].sort(),
    );
  });

  it('uses the Plan 07 deployment confirmation shape and requires replace data disposition', async () => {
    const calls: unknown[] = [];
    const release: ReleasePort = {
      ...defaultPorts().release,
      deploy: (releaseId, input, options) => {
        calls.push({ releaseId, input, idempotencyKey: options?.idempotencyKey });
        return Promise.resolve({ deploymentId: 'deployment_test' });
      },
    };
    type Plan07Deploy = (
      releaseId: string,
      input: {
        deploymentType: 'first_deploy' | 'redeploy' | 'replace_deployment';
        confirmation: { dataDisposition: 'preserve' | 'transfer' | 'reset' | null };
      },
    ) => Promise<unknown>;
    const plan07CompatibleDeploy: Plan07Deploy = (releaseId, input) =>
      release.deploy(releaseId, input);
    void plan07CompatibleDeploy;
    const registry = registryFor(new RecordingRuntime(), { release });
    const definition = registry.get('deploy_release');

    for (const deploymentType of ['first_deploy', 'redeploy'] as const) {
      expect(
        definition.inputSchema.safeParse({ releaseId: 'release_test', deploymentType }).success,
      ).toBe(true);
      expect(
        definition.inputSchema.safeParse({
          releaseId: 'release_test',
          deploymentType,
          dataDisposition: 'preserve',
        }).success,
      ).toBe(false);
    }
    expect(
      definition.inputSchema.safeParse({
        releaseId: 'release_test',
        deploymentType: 'replace_deployment',
      }).success,
    ).toBe(false);
    for (const dataDisposition of ['preserve', 'transfer', 'reset'] as const) {
      expect(
        definition.inputSchema.safeParse({
          releaseId: 'release_test',
          deploymentType: 'replace_deployment',
          dataDisposition,
        }).success,
      ).toBe(true);
    }
    expect(
      definition.inputSchema.safeParse({
        releaseId: 'release_test',
        deploymentType: 'redeploy',
        confirmationId: 'invented',
      }).success,
    ).toBe(false);

    for (const input of [
      { releaseId: 'release_test', deploymentType: 'first_deploy' as const },
      { releaseId: 'release_test', deploymentType: 'redeploy' as const },
      {
        releaseId: 'release_test',
        deploymentType: 'replace_deployment' as const,
        dataDisposition: 'preserve' as const,
      },
    ]) {
      await registry.execute('deploy_release', input, trustedContext);
    }
    expect(calls).toEqual([
      {
        releaseId: 'release_test',
        input: {
          deploymentType: 'first_deploy',
          confirmation: { dataDisposition: null },
        },
        idempotencyKey: 'run_trusted:task_trusted:step-1:deploy_release',
      },
      {
        releaseId: 'release_test',
        input: {
          deploymentType: 'redeploy',
          confirmation: { dataDisposition: null },
        },
        idempotencyKey: 'run_trusted:task_trusted:step-1:deploy_release',
      },
      {
        releaseId: 'release_test',
        input: {
          deploymentType: 'replace_deployment',
          confirmation: { dataDisposition: 'preserve' },
        },
        idempotencyKey: 'run_trusted:task_trusted:step-1:deploy_release',
      },
    ]);
  });

  it('derives mutation idempotency keys from trusted context and marks rollback metadata truthfully', async () => {
    const calls: unknown[] = [];
    const release: ReleasePort = {
      ...defaultPorts().release,
      rollback: (_input, options) => {
        calls.push(options);
        return Promise.resolve({ deploymentId: 'deployment_rollback' });
      },
    };
    const registry = registryFor(new RecordingRuntime(), { release });

    await registry.execute('rollback_release', toolInputs.rollback_release, trustedContext);
    expect(calls).toEqual([
      expect.objectContaining({
        idempotencyKey: 'run_trusted:task_trusted:step-1:rollback_release',
      }),
    ]);
    expect(registry.get('rollback_release').idempotent).toBe(false);
    await expect(
      registry.execute(
        'rollback_release',
        { ...(toolInputs.rollback_release as object), idempotencyKey: 'model-key' },
        trustedContext,
      ),
    ).rejects.toThrow();
  });

  it('aborts a cancellable service operation when the registry timeout wins', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const browser: BrowserEvidencePort = {
      ...defaultPorts().browser,
      captureScreenshot: (_input, _context, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(
              signal.reason instanceof Error ? signal.reason : new Error('Operation aborted'),
            );
          });
        }),
    };

    try {
      const execution = registryFor(new RecordingRuntime(), { browser }).execute(
        'capture_screenshot',
        { previewId: 'preview_test', route: '/', name: 'home' },
        trustedContext,
      );
      const timedOut = expect(execution).rejects.toMatchObject({ code: 'tool_timeout' });
      await vi.advanceTimersByTimeAsync(60_001);
      await timedOut;
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a caller-aborted tool before starting its service operation', async () => {
    let calls = 0;
    const projectData: ProjectDataPort = {
      ...defaultPorts().projectData,
      readLogs: () => {
        calls += 1;
        return Promise.resolve({ ok: true, entries: [], truncated: false });
      },
    };
    const caller = new AbortController();
    caller.abort(new Error('caller stopped run'));

    await expect(
      registryFor(new RecordingRuntime(), { projectData }).execute(
        'read_logs',
        {},
        trustedContext,
        caller.signal,
      ),
    ).rejects.toMatchObject({ code: 'tool_cancelled' });
    expect(calls).toBe(0);
  });

  it('propagates in-flight caller cancellation and halts retries immediately', async () => {
    let calls = 0;
    let receivedSignal: AbortSignal | undefined;
    const projectData: ProjectDataPort = {
      ...defaultPorts().projectData,
      readLogs: (_input, _context, signal) => {
        calls += 1;
        receivedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
            },
            { once: true },
          );
        });
      },
    };
    const caller = new AbortController();
    const execution = registryFor(new RecordingRuntime(), { projectData }).execute(
      'read_logs',
      {},
      trustedContext,
      caller.signal,
    );
    await vi.waitFor(() => {
      expect(calls).toBe(1);
    });

    caller.abort(new Error('caller stopped run'));

    await expect(execution).rejects.toMatchObject({ code: 'tool_cancelled' });
    expect(receivedSignal?.aborted).toBe(true);
    expect(calls).toBe(1);
  });
});
