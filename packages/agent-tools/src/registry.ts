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

export type ToolAuditPayload = Record<string, string | number | boolean>;

export interface ToolExecutionWithAudit {
  readonly output: unknown;
  readonly context: ToolExecutionContext;
  readonly auditPayload: ToolAuditPayload;
}

export type ToolAuditRecorder = (payload: ToolAuditPayload) => void;

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
    recordAudit: ToolAuditRecorder,
  ): Promise<unknown>;
}

type UnknownSchema = z.ZodType<unknown, z.ZodTypeDef, unknown>;

export interface AnyToolSpec extends ToolDefinition<UnknownSchema, UnknownSchema> {
  run(
    input: unknown,
    context: ToolExecutionContext,
    signal: AbortSignal,
    recordAudit: ToolAuditRecorder,
  ): Promise<unknown>;
}

export interface ExecutableToolDefinition extends ToolDefinition<UnknownSchema, UnknownSchema> {
  execute(rawInput: unknown, rawContext: unknown, callerSignal?: AbortSignal): Promise<unknown>;
  executeWithAudit(
    rawInput: unknown,
    rawContext: unknown,
    callerSignal?: AbortSignal,
  ): Promise<ToolExecutionWithAudit>;
}

export class ToolExecutionError extends Error {
  readonly code: 'tool_failed' | 'tool_timeout' | 'tool_cancelled';

  constructor(tool: ToolName, code: 'tool_failed' | 'tool_timeout' | 'tool_cancelled') {
    super(
      code === 'tool_timeout'
        ? `${tool} timed out`
        : code === 'tool_cancelled'
          ? `${tool} was cancelled`
          : `${tool} failed`,
    );
    this.name = 'ToolExecutionError';
    this.code = code;
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason as unknown;
  return reason instanceof Error ? reason : new Error('Tool execution cancelled');
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  tool: ToolName,
  controller: AbortController,
  callerSignal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation: ((reason: unknown) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const onCallerAbort = (): void => {
    const error = new ToolExecutionError(tool, 'tool_cancelled');
    controller.abort(error);
    rejectCancellation?.(error);
  };
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new ToolExecutionError(tool, 'tool_timeout');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout, cancellation]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    callerSignal?.removeEventListener('abort', onCallerAbort);
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

function redactAuditPayload(payload: ToolAuditPayload, redactor: OutputRedactor): ToolAuditPayload {
  const redacted: ToolAuditPayload = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`Audit payload field ${key} must be scalar`);
    }
    redacted[key] = typeof value === 'string' ? redactor.redact(value) : value;
  }
  return redacted;
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

  execute(
    name: ToolName,
    rawInput: unknown,
    rawContext: unknown,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    return this.get(name).execute(rawInput, rawContext, callerSignal);
  }

  executeWithAudit(
    name: ToolName,
    rawInput: unknown,
    rawContext: unknown,
    callerSignal?: AbortSignal,
  ): Promise<ToolExecutionWithAudit> {
    return this.get(name).executeWithAudit(rawInput, rawContext, callerSignal);
  }

  private makeExecutable(spec: AnyToolSpec, redactor: OutputRedactor): ExecutableToolDefinition {
    const executeWithAudit = async (
      rawInput: unknown,
      rawContext: unknown,
      callerSignal?: AbortSignal,
    ): Promise<ToolExecutionWithAudit> => {
      const input = spec.inputSchema.parse(rawInput);
      const context = ToolExecutionContextSchema.parse(rawContext);
      let lastError: unknown;

      for (let attempt = 1; attempt <= spec.retryPolicy.maxAttempts; attempt += 1) {
        if (isAborted(callerSignal)) {
          throw new ToolExecutionError(spec.name, 'tool_cancelled');
        }
        const controller = new AbortController();
        const recordedAudit: ToolAuditPayload = {};
        const recordAudit: ToolAuditRecorder = (payload) => {
          Object.assign(recordedAudit, payload);
        };
        try {
          const rawOutput = await withTimeout(
            spec.run(input, context, controller.signal, recordAudit),
            spec.timeoutMs,
            spec.name,
            controller,
            callerSignal,
          );
          const output = spec.outputSchema.parse(rawOutput);
          const visibleOutput = spec.redactOutput ? redactValue(output, redactor) : output;
          const parsedOutput = spec.outputSchema.parse(visibleOutput);
          return {
            output: parsedOutput,
            context,
            auditPayload: redactAuditPayload(
              { ...spec.auditPayload(input, parsedOutput), ...recordedAudit },
              redactor,
            ),
          };
        } catch (error: unknown) {
          if (error instanceof PathViolationError) {
            throw error;
          }
          if (
            (error instanceof ToolExecutionError && error.code === 'tool_cancelled') ||
            isAborted(callerSignal)
          ) {
            throw new ToolExecutionError(spec.name, 'tool_cancelled');
          }
          lastError = error;
          if (attempt < spec.retryPolicy.maxAttempts) {
            try {
              await sleep(spec.retryPolicy.backoffMs, callerSignal);
            } catch {
              throw new ToolExecutionError(spec.name, 'tool_cancelled');
            }
          }
        }
      }

      if (lastError instanceof ToolExecutionError && lastError.code === 'tool_timeout') {
        throw lastError;
      }
      throw new ToolExecutionError(spec.name, 'tool_failed');
    };
    const execute = async (
      rawInput: unknown,
      rawContext: unknown,
      callerSignal?: AbortSignal,
    ): Promise<unknown> =>
      (await executeWithAudit(rawInput, rawContext, callerSignal)).output;

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
      auditPayload: (input, output) =>
        redactAuditPayload(spec.auditPayload(input, output), redactor),
      execute,
      executeWithAudit,
    };
  }
}
