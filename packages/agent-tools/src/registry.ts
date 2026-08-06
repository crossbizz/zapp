import { TOOL_NAMES, type ToolDefinition, type ToolName } from '@zapp/contracts';
import { PathViolationError, type WorkspaceRuntime } from '@zapp/workspace-runtime';
import { z } from 'zod';
import { createExecutionTools, type BrowserEvidencePort } from './execution.js';
import { createGitTools } from './git.js';
import { createMutationTools, type EnvironmentPort, type MigrationPort } from './mutation.js';
import { createReadTools, type ProjectDataPort } from './read.js';
import {
  createReleaseTools,
  type DeploymentHealthPort,
  type PreviewToolPort,
  type ReleasePort,
} from './release.js';

export type {
  BrowserEvidencePort,
  DeploymentHealthPort,
  EnvironmentPort,
  MigrationPort,
  PreviewToolPort,
  ProjectDataPort,
  ReleasePort,
};

export interface OutputRedactor {
  redact(value: string): string;
}

export const ToolExecutionContextSchema = z
  .object({
    organizationId: z.string().min(1),
    projectId: z.string().min(1),
    runId: z.string().min(1),
    taskId: z.string().min(1),
    step: z.string().min(1),
  })
  .strict();

export type ToolExecutionContext = z.infer<typeof ToolExecutionContextSchema>;

export interface ToolMutationContext extends ToolExecutionContext {
  readonly idempotencyKey: string;
}

export function mutationContext(
  context: ToolExecutionContext,
  tool: ToolName,
): ToolMutationContext {
  return {
    ...context,
    idempotencyKey: `${context.runId}:${context.taskId}:${context.step}:${tool}`,
  };
}

export interface ToolRegistryDependencies {
  readonly runtime: WorkspaceRuntime;
  readonly redactor: OutputRedactor;
  readonly projectData: ProjectDataPort;
  readonly migrations: MigrationPort;
  readonly environment: EnvironmentPort;
  readonly browser: BrowserEvidencePort;
  readonly release: ReleasePort;
  readonly preview: PreviewToolPort;
  readonly deploymentHealth: DeploymentHealthPort;
}

export interface ToolSpec<I extends z.ZodTypeAny, O extends z.ZodTypeAny> extends ToolDefinition<
  I,
  O
> {
  run(
    input: z.infer<I>,
    context: ToolExecutionContext,
    signal: AbortSignal,
  ): Promise<unknown>;
}

type UnknownSchema = z.ZodType<unknown, z.ZodTypeDef, unknown>;

export interface AnyToolSpec extends ToolDefinition<UnknownSchema, UnknownSchema> {
  run(input: unknown, context: ToolExecutionContext, signal: AbortSignal): Promise<unknown>;
}

export interface ExecutableToolDefinition extends ToolDefinition<UnknownSchema, UnknownSchema> {
  execute(rawInput: unknown, rawContext: unknown): Promise<unknown>;
}

export class ToolExecutionError extends Error {
  readonly code: 'tool_failed' | 'tool_timeout';

  constructor(tool: ToolName, code: 'tool_failed' | 'tool_timeout') {
    super(code === 'tool_timeout' ? `${tool} timed out` : `${tool} failed`);
    this.name = 'ToolExecutionError';
    this.code = code;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  tool: ToolName,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new ToolExecutionError(tool, 'tool_timeout');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function redactValue(value: unknown, redactor: OutputRedactor): unknown {
  if (typeof value === 'string') {
    return redactor.redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, redactor));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry, redactor)]),
    );
  }
  return value;
}

function assertExactRegistry(specs: readonly AnyToolSpec[]): void {
  if (
    specs.length !== TOOL_NAMES.length ||
    specs.some((spec, index) => spec.name !== TOOL_NAMES[index])
  ) {
    throw new Error('Tool registry must match TOOL_NAMES exactly and in order');
  }
}

export class ToolRegistry {
  private readonly definitions: ReadonlyMap<ToolName, ExecutableToolDefinition>;

  constructor(dependencies: ToolRegistryDependencies) {
    const specs = [
      ...createReadTools(dependencies.runtime, dependencies.projectData),
      ...createMutationTools(
        dependencies.runtime,
        dependencies.migrations,
        dependencies.environment,
      ),
      ...createExecutionTools(
        dependencies.runtime,
        dependencies.browser,
        dependencies.projectData,
      ),
      ...createGitTools(dependencies.runtime),
      ...createReleaseTools(
        dependencies.release,
        dependencies.preview,
        dependencies.deploymentHealth,
      ),
    ];
    assertExactRegistry(specs);
    this.definitions = new Map(
      specs.map((spec) => [spec.name, this.makeExecutable(spec, dependencies.redactor)]),
    );
  }

  names(): readonly ToolName[] {
    return TOOL_NAMES;
  }

  get(name: ToolName): ExecutableToolDefinition {
    const definition = this.definitions.get(name);
    if (definition === undefined) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return definition;
  }

  execute(name: ToolName, rawInput: unknown, rawContext: unknown): Promise<unknown> {
    return this.get(name).execute(rawInput, rawContext);
  }

  private makeExecutable(spec: AnyToolSpec, redactor: OutputRedactor): ExecutableToolDefinition {
    const execute = async (rawInput: unknown, rawContext: unknown): Promise<unknown> => {
      const input = spec.inputSchema.parse(rawInput);
      const context = ToolExecutionContextSchema.parse(rawContext);
      let lastError: unknown;

      for (let attempt = 1; attempt <= spec.retryPolicy.maxAttempts; attempt += 1) {
        const controller = new AbortController();
        try {
          const rawOutput = await withTimeout(
            spec.run(input, context, controller.signal),
            spec.timeoutMs,
            spec.name,
            controller,
          );
          const output = spec.outputSchema.parse(rawOutput);
          const visibleOutput = spec.redactOutput ? redactValue(output, redactor) : output;
          return spec.outputSchema.parse(visibleOutput);
        } catch (error: unknown) {
          if (error instanceof PathViolationError) {
            throw error;
          }
          lastError = error;
          if (attempt < spec.retryPolicy.maxAttempts) {
            await sleep(spec.retryPolicy.backoffMs);
          }
        }
      }

      if (lastError instanceof ToolExecutionError && lastError.code === 'tool_timeout') {
        throw lastError;
      }
      throw new ToolExecutionError(spec.name, 'tool_failed');
    };

    return {
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: spec.outputSchema,
      classification: spec.classification,
      riskLevel: spec.riskLevel,
      approvalPolicy: spec.approvalPolicy,
      idempotent: spec.idempotent,
      timeoutMs: spec.timeoutMs,
      retryPolicy: spec.retryPolicy,
      redactOutput: spec.redactOutput,
      userSummary: (input, output) => spec.userSummary(input, output),
      auditPayload: (input, output) => spec.auditPayload(input, output),
      execute,
    };
  }
}
