import {
  ToolRegistry,
  type OutputRedactor,
  type ProjectDataPort,
} from '@zapp/agent-tools';
import { posix } from 'node:path';
import {
  ExecutionContractSchema,
  type ExecutionContract,
  type ToolName,
} from '@zapp/contracts';
import { scanProjectCapabilities } from '@zapp/project-adapters';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';

import {
  adaptSessionLoop,
  type BuilderSessionRunner,
  type RunBuilderSessionInput,
} from '../activities/session.js';
import {
  AssembledContextSchema,
  type AssembledContext,
} from '../session/context.js';
import {
  createSessionLoop,
  type AgentRole,
  type SessionEvent,
  type SessionGateway,
  type SessionLoopDependencies,
} from '../session/loop.js';
import { createM1UnavailablePorts, M1PortUnavailableError } from './unavailable-ports.js';

const M1_TASK_ID = 'm1-builder';
const M1_CONTEXT_TOKEN_BUDGET = 12_000;
const M1_UNAVAILABLE_TOOL_NAMES = new Set<ToolName>([
  'execute_migration',
  'set_environment_variable',
  'run_browser_tests',
  'capture_screenshot',
  'inspect_browser_console',
  'inspect_network_requests',
  'create_preview',
  'run_preview_smoke_test',
  'create_release_candidate',
  'deploy_release',
  'check_deployment_health',
  'rollback_release',
]);
const M1_LOCAL_CAPABILITY_INSTRUCTIONS =
  'Browser evidence, release, deployment, environment, and migration tools are unavailable in the local runtime. Verify the application with its build, typecheck, lint, tests, development server, and logs, then finish with a concise summary.';
const M1_IGNORED_FILE_TREE_SEGMENTS = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'node_modules',
]);
const M1_SESSION_BUDGETS = {
  maxTurns: 32,
  maxTokens: 1_000_000,
  maxWallClockMs: 30 * 60_000,
} as const;
const M1_BOOTSTRAP_EXECUTION_CONTRACT = ExecutionContractSchema.parse({
  version: 1,
  package_manager: 'pnpm',
  workspace_root: '.',
  install: { command: 'pnpm install' },
  develop: { command: 'pnpm dev', port: 3000 },
  build: { command: 'pnpm build' },
});

export interface SessionEventPublisher {
  emit(event: SessionEvent): void | Promise<void>;
}

export type ApprovalPort = SessionLoopDependencies['approvals'];
export type RolePromptRegistry = Readonly<Record<AgentRole, string>>;
export type Redactor = OutputRedactor;
export interface TokenCounter {
  countRequestTokens(request: Parameters<SessionGateway['stream']>[0]): number;
}

export interface M1BuilderSessionOptions {
  readonly gateway: SessionGateway;
  readonly runtime: WorkspaceRuntime;
  readonly events: SessionEventPublisher;
  readonly approvals: ApprovalPort;
  readonly prompts: RolePromptRegistry;
  readonly redactor: Redactor;
  readonly tokenCounter: TokenCounter;
}

export class M1DevServerUnhealthyError extends Error {
  public constructor() {
    super('The M1 development server did not become healthy');
    this.name = 'M1DevServerUnhealthyError';
  }
}

export class M1SandboxBoundaryError extends Error {
  public constructor() {
    super('The M1 builder requires a network-profiled cloud sandbox runtime');
    this.name = 'M1SandboxBoundaryError';
  }
}

function isProjectSourceEntry(path: string): boolean {
  return !path.split('/').some((segment) => M1_IGNORED_FILE_TREE_SEGMENTS.has(segment));
}

async function listProjectEntries(
  runtime: WorkspaceRuntime,
  path: string,
  options?: { readonly glob?: string; readonly maxDepth?: number },
) {
  return (await runtime.listFiles(path, options)).filter((entry) => isProjectSourceEntry(entry.path));
}

interface RuntimeWithDevServerLogs extends WorkspaceRuntime {
  readDevServerLogs(input?: {
    readonly after?: number;
    readonly limit?: number;
  }): Promise<{
    readonly entries: readonly {
      readonly at: string;
      readonly stream: 'stdout' | 'stderr';
      readonly message: string;
    }[];
    readonly truncated: boolean;
  }>;
}

function hasDevServerLogs(runtime: WorkspaceRuntime): runtime is RuntimeWithDevServerLogs {
  return 'readDevServerLogs' in runtime && typeof runtime.readDevServerLogs === 'function';
}

function projectDataPort(runtime: WorkspaceRuntime): ProjectDataPort {
  return {
    async readLogs(input) {
      if (!hasDevServerLogs(runtime)) throw new M1PortUnavailableError('workspace logs');
      const logs = await runtime.readDevServerLogs({ limit: input.limit });
      return {
        ok: true,
        entries: logs.entries.map((entry) => ({
          timestamp: entry.at,
          level: entry.stream === 'stderr' ? 'error' : 'info',
          message: entry.message,
        })),
        truncated: logs.truncated,
      };
    },
    readTestResults: () => Promise.reject(new M1PortUnavailableError('stored test results')),
    readDatabaseSchema: () => Promise.reject(new M1PortUnavailableError('database schema')),
    async readLatestProjectContract() {
      const rootManifest = await runtime.listFiles('.', {
        glob: 'package.json',
        maxDepth: 1,
      });
      if (!rootManifest.some((entry) => entry.type === 'file' && entry.path === 'package.json')) {
        return { ok: true, version: 1, contract: M1_BOOTSTRAP_EXECUTION_CONTRACT };
      }
      const result = await scanProjectCapabilities({
        workspaceRoot: '.',
        listFiles: async (glob) =>
          (await listProjectEntries(runtime, '.', { glob, maxDepth: 100 }))
            .filter((entry) => entry.type === 'file')
            .map((entry) => entry.path),
        readFile: async (path) => new TextDecoder().decode(await runtime.readFile(path)),
      });
      return { ok: true, version: 1, contract: result.contract };
    },
  };
}

function healthCheckedRuntime(runtime: WorkspaceRuntime): WorkspaceRuntime {
  const writeFile = async (path: string, data: Uint8Array): Promise<void> => {
    try {
      await runtime.writeFile(path, data);
      return;
    } catch (error: unknown) {
      const components = path.split('/');
      const parent = posix.dirname(path);
      if (
        posix.isAbsolute(path) ||
        path.includes('\0') ||
        components.includes('..') ||
        parent === '.'
      ) {
        throw error;
      }
      const created = await runtime.exec({
        cmd: 'mkdir',
        args: ['-p', '--', parent],
        cwd: '.',
        timeoutMs: 30_000,
      });
      if (created.exitCode !== 0) throw error;
      await runtime.writeFile(path, data);
    }
  };
  const startAndCheck = async (
    start: (contract: ExecutionContract) => Promise<{ port: number; pid: number }>,
    contract: ExecutionContract,
  ): Promise<{ port: number; pid: number }> => {
    const started = await start(contract);
    const health = await runtime.health();
    if (!health.ok) throw new M1DevServerUnhealthyError();
    return started;
  };
  return {
    kind: runtime.kind,
    exec: (input) => runtime.exec(input),
    execStream: (input) => runtime.execStream(input),
    readFile: (path) => runtime.readFile(path),
    readFileForUpdate: (path) => runtime.readFileForUpdate(path),
    writeFile,
    writeFilesAtomically: (files) => runtime.writeFilesAtomically(files),
    search: (input) => runtime.search(input),
    listFiles: (path, options) => listProjectEntries(runtime, path, options),
    stat: (path) => runtime.stat(path),
    delete: (path) => runtime.delete(path),
    deleteFile: (path) => runtime.deleteFile(path),
    renameFile: (input) => runtime.renameFile(input),
    git: (operation) => runtime.git(operation),
    startDevServer: (contract) =>
      startAndCheck((value) => runtime.startDevServer(value), contract),
    restartDevServer: (contract) =>
      startAndCheck((value) => runtime.restartDevServer(value), contract),
    health: () => runtime.health(),
  };
}

export function createM1ToolRegistry(
  runtime: WorkspaceRuntime,
  redactor: OutputRedactor,
): ToolRegistry {
  const unavailable = createM1UnavailablePorts();
  return new ToolRegistry({
    runtime: healthCheckedRuntime(runtime),
    redactor,
    projectData: projectDataPort(runtime),
    ...unavailable,
  });
}

function approximateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function contextFor(input: RunBuilderSessionInput): AssembledContext {
  const tokenCount = approximateTokens(input.prompt);
  return AssembledContextSchema.parse({
    role: 'builder',
    scope: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      runId: input.runId,
    },
    taskId: M1_TASK_ID,
    tokenBudget: M1_CONTEXT_TOKEN_BUDGET,
    tokenCount,
    sections: [
      {
        kind: 'currentTask',
        content: input.prompt,
        tokenCount,
        sourceArtifactIds: [],
        sourceEventIds: [],
      },
    ],
  });
}

export function createM1BuilderSessionRunner(
  options: M1BuilderSessionOptions,
): BuilderSessionRunner {
  if (options.runtime.kind !== 'cloud') throw new M1SandboxBoundaryError();
  const registry = createM1ToolRegistry(options.runtime, options.redactor);
  const runner = adaptSessionLoop(
    (transcripts, contextEvents) =>
      createSessionLoop({
        gateway: options.gateway,
        tools: registry,
        transcripts,
        events: {
          async emit(event) {
            await contextEvents.emit(event);
            await options.events.emit(event);
          },
        },
        approvals: options.approvals,
        prompts: options.prompts,
        redact: (value) => options.redactor.redact(value),
        countRequestTokens: (request) => options.tokenCounter.countRequestTokens(request),
        executionBoundary: 'network_profiled_sandbox',
      }),
    (input) => ({
      runId: input.runId,
      taskId: M1_TASK_ID,
      role: 'builder',
      mode: input.mode,
      context: contextFor(input),
      tools: input.allowedTools,
      modeInstructions: input.modeInstructions,
      budgets: M1_SESSION_BUDGETS,
    }),
  );
  return {
    run(input, context) {
      return runner.run(
        {
          ...input,
          allowedTools: input.allowedTools.filter(
            (tool) => !M1_UNAVAILABLE_TOOL_NAMES.has(tool),
          ),
          modeInstructions: `${input.modeInstructions}\n${M1_LOCAL_CAPABILITY_INSTRUCTIONS}`,
        },
        context,
      );
    },
  };
}
