import {
  ToolRegistry,
  type OutputRedactor,
  type ProjectDataPort,
} from '@zapp/agent-tools';
import type { ExecutionContract } from '@zapp/contracts';
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
const M1_SESSION_BUDGETS = {
  maxTurns: 32,
  maxTokens: 64_000,
  maxWallClockMs: 30 * 60_000,
} as const;

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
      const result = await scanProjectCapabilities({
        workspaceRoot: '.',
        listFiles: async (glob) =>
          (await runtime.listFiles('.', { glob, maxDepth: 100 }))
            .filter((entry) => entry.type === 'file')
            .map((entry) => entry.path),
        readFile: async (path) => new TextDecoder().decode(await runtime.readFile(path)),
      });
      return { ok: true, version: 1, contract: result.contract };
    },
  };
}

function healthCheckedRuntime(runtime: WorkspaceRuntime): WorkspaceRuntime {
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
    writeFile: (path, data) => runtime.writeFile(path, data),
    writeFilesAtomically: (files) => runtime.writeFilesAtomically(files),
    search: (input) => runtime.search(input),
    listFiles: (path, options) => runtime.listFiles(path, options),
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
  return adaptSessionLoop(
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
}
