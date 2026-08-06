import { ExecutionContractSchema, type ExecutionContract } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { z } from 'zod';
import type {
  AnyToolSpec,
  ToolExecutionContext,
  ToolMutationContext,
  ToolSpec,
} from './registry.js';
import { mutationContext } from './registry.js';
import type { ProjectDataPort } from './read.js';

const EmptyInputSchema = z.object({}).strict();
const routeSchema = z
  .string()
  .min(1)
  .refine(
    (route) =>
      route.startsWith('/') &&
      !route.startsWith('//') &&
      !route.includes('://') &&
      !route.includes('\\') &&
      !/[\u0000-\u001f\u007f]/u.test(route),
    'Browser route must be an origin-relative path',
  );
const previewTargetSchema = z
  .object({ previewId: z.string().min(1), route: routeSchema })
  .strict();
const deploymentTargetSchema = z
  .object({ deploymentId: z.string().min(1), route: routeSchema })
  .strict();
const BrowserTargetInputSchema = z.union([previewTargetSchema, deploymentTargetSchema]);
const CaptureScreenshotInputSchema = z.union([
  previewTargetSchema.extend({ name: z.string().min(1) }).strict(),
  deploymentTargetSchema.extend({ name: z.string().min(1) }).strict(),
]);

const BrowserTestsOutputSchema = z.discriminatedUnion('passed', [
  z.object({ ok: z.literal(true), passed: z.literal(true), summary: z.string() }).strict(),
  z.object({ ok: z.literal(false), passed: z.literal(false), summary: z.string() }).strict(),
]);
const ScreenshotOutputSchema = z
  .object({ ok: z.literal(true), artifactId: z.string().min(1), path: z.string().min(1) })
  .strict();
const ConsoleOutputSchema = z
  .object({
    ok: z.literal(true),
    entries: z.array(
      z
        .object({ level: z.string().min(1), message: z.string(), timestamp: z.string().min(1) })
        .strict(),
    ),
  })
  .strict();
const NetworkOutputSchema = z
  .object({
    ok: z.literal(true),
    requests: z.array(
      z
        .object({
          method: z.string().min(1),
          url: z.string().url(),
          status: z.number().int().min(0).max(599),
        })
        .strict(),
    ),
  })
  .strict();

const BrowserTestsPortOutputSchema = z
  .object({ passed: z.boolean(), summary: z.string() })
  .strict();
const ScreenshotPortOutputSchema = z
  .object({ artifactId: z.string().min(1), path: z.string().min(1) })
  .strict();
const ConsolePortOutputSchema = ConsoleOutputSchema.omit({ ok: true }).strict();
const NetworkPortOutputSchema = NetworkOutputSchema.omit({ ok: true }).strict();

type BrowserTarget = z.infer<typeof BrowserTargetInputSchema>;
type ScreenshotTarget = z.infer<typeof CaptureScreenshotInputSchema>;

export interface BrowserEvidencePort {
  runBrowserTests(
    input: BrowserTarget & { readonly command: string; readonly workspaceRoot: string },
    context: ToolMutationContext,
    signal: AbortSignal,
  ): Promise<unknown>;
  captureScreenshot(
    input: ScreenshotTarget,
    context: ToolMutationContext,
    signal: AbortSignal,
  ): Promise<unknown>;
  inspectConsole(
    input: BrowserTarget,
    context: ToolMutationContext,
    signal: AbortSignal,
  ): Promise<unknown>;
  inspectNetwork(
    input: BrowserTarget,
    context: ToolMutationContext,
    signal: AbortSignal,
  ): Promise<unknown>;
}

const CommandInputSchema = z
  .object({
    cmd: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .strict();
const ExecOutputSchema = z
  .object({
    ok: z.boolean(),
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
const DevServerOutputSchema = z
  .object({
    ok: z.literal(true),
    port: z.number().int().positive(),
    pid: z.number().int().positive(),
  })
  .strict();
const LatestContractPortOutputSchema = z
  .object({ ok: z.literal(true), version: z.number().int().positive(), contract: ExecutionContractSchema })
  .strict();

function executionTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  spec: Omit<
    ToolSpec<I, O>,
    'classification' | 'riskLevel' | 'approvalPolicy' | 'retryPolicy' | 'redactOutput'
  >,
): AnyToolSpec {
  return {
    ...spec,
    classification: 'mutating',
    riskLevel: 'medium',
    approvalPolicy: 'policy',
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    redactOutput: true,
  } as unknown as AnyToolSpec;
}

function execOutput(
  result: Awaited<ReturnType<WorkspaceRuntime['exec']>>,
): z.infer<typeof ExecOutputSchema> {
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    truncated: result.truncated,
  };
}

async function runCommand(
  runtime: WorkspaceRuntime,
  input: z.infer<typeof CommandInputSchema>,
): Promise<z.infer<typeof ExecOutputSchema>> {
  return execOutput(
    await runtime.exec({
      cmd: input.cmd,
      args: input.args,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      timeoutMs: input.timeoutMs ?? 120_000,
    }),
  );
}

async function latestContract(
  projectData: ProjectDataPort,
  context: ToolExecutionContext,
  signal: AbortSignal,
): Promise<ExecutionContract> {
  const result = LatestContractPortOutputSchema.parse(
    await projectData.readLatestProjectContract(context, signal),
  );
  return result.contract;
}

function commandFor(
  contract: ExecutionContract,
  kind: 'build' | 'typecheck' | 'lint' | 'unit' | 'integration',
): { command: string; timeoutMs: number } | undefined {
  if (kind === 'unit' || kind === 'integration') {
    const command = contract.test?.[kind];
    return command === undefined
      ? undefined
      : { command, timeoutMs: 120_000 };
  }
  const block = contract[kind];
  if (block === undefined) return undefined;
  return {
    command: block.command,
    timeoutMs:
      'timeout_seconds' in block && block.timeout_seconds !== undefined
        ? Math.min(block.timeout_seconds * 1_000, 120_000)
        : 120_000,
  };
}

function notConfigured(label: string): z.infer<typeof ExecOutputSchema> {
  return {
    ok: false,
    exitCode: 2,
    stdout: '',
    stderr: `Execution contract does not define ${label}`,
    durationMs: 0,
    truncated: false,
  };
}

function commandSummary(label: string, output: z.infer<typeof ExecOutputSchema>): string {
  return output.ok ? `${label} completed` : `${label} failed (exit ${String(output.exitCode)})`;
}

export function createExecutionTools(
  runtime: WorkspaceRuntime,
  browser: BrowserEvidencePort,
  projectData: ProjectDataPort,
): AnyToolSpec[] {
  const namedCommands = [
    ['run_build', 'Run the project build command', 'Build', 'build'] as const,
    ['run_typecheck', 'Run the project typecheck command', 'Typecheck', 'typecheck'] as const,
    ['run_lint', 'Run the project lint command', 'Lint', 'lint'] as const,
    ['run_unit_tests', 'Run the project unit-test command', 'Unit tests', 'unit'] as const,
    [
      'run_integration_tests',
      'Run the project integration-test command',
      'Integration tests',
      'integration',
    ] as const,
  ].map(([name, description, label, kind]) =>
    executionTool({
      name,
      description,
      inputSchema: EmptyInputSchema,
      outputSchema: ExecOutputSchema,
      idempotent: false,
      timeoutMs: 120_000,
      run: async (_input, context, signal) => {
        const contract = await latestContract(projectData, context, signal);
        const configured = commandFor(contract, kind);
        return configured === undefined
          ? notConfigured(kind)
          : execOutput(
              await runtime.exec({
                cmd: 'sh',
                args: ['-lc', configured.command],
                cwd: contract.workspace_root,
                timeoutMs: configured.timeoutMs,
              }),
            );
      },
      userSummary: (_input, output) => commandSummary(label, output),
      auditPayload: (_input, output) => ({ exitCode: output.exitCode, ok: output.ok }),
    }),
  );
  const named = new Map(namedCommands.map((tool) => [tool.name, tool]));
  const requiredNamed = (name: (typeof namedCommands)[number]['name']): AnyToolSpec => {
    const tool = named.get(name);
    if (tool === undefined) throw new Error(`Missing execution tool ${name}`);
    return tool;
  };

  return [
    executionTool({
      name: 'run_command',
      description: 'Run an explicitly requested workspace command.',
      inputSchema: CommandInputSchema,
      outputSchema: ExecOutputSchema,
      idempotent: false,
      timeoutMs: 120_000,
      run: (input) => runCommand(runtime, input),
      userSummary: (_input, output) => commandSummary('Command', output),
      auditPayload: (input, output) => ({
        command: input.cmd,
        argumentCount: input.args.length,
        exitCode: output.exitCode,
        ok: output.ok,
      }),
    }),
    executionTool({
      name: 'run_dev_server',
      description: 'Start the latest contracted project development server.',
      inputSchema: EmptyInputSchema,
      outputSchema: DevServerOutputSchema,
      idempotent: false,
      timeoutMs: 30_000,
      run: async (_input, context, signal) => ({
        ok: true,
        ...(await runtime.startDevServer(await latestContract(projectData, context, signal))),
      }),
      userSummary: (_input, output) => `Started development server on port ${String(output.port)}`,
      auditPayload: (_input, output) => ({ port: output.port, pid: output.pid }),
    }),
    executionTool({
      name: 'restart_dev_server',
      description: 'Restart the supervised project development server.',
      inputSchema: EmptyInputSchema,
      outputSchema: DevServerOutputSchema,
      idempotent: false,
      timeoutMs: 30_000,
      run: async (_input, context, signal) => ({
        ok: true,
        ...(await runtime.restartDevServer(await latestContract(projectData, context, signal))),
      }),
      userSummary: (_input, output) =>
        `Restarted development server on port ${String(output.port)}`,
      auditPayload: (_input, output) => ({ port: output.port, pid: output.pid }),
    }),
    requiredNamed('run_build'),
    requiredNamed('run_typecheck'),
    requiredNamed('run_lint'),
    requiredNamed('run_unit_tests'),
    requiredNamed('run_integration_tests'),
    executionTool({
      name: 'run_browser_tests',
      description: 'Run the latest contracted browser tests against an attributed target.',
      inputSchema: BrowserTargetInputSchema,
      outputSchema: BrowserTestsOutputSchema,
      idempotent: false,
      timeoutMs: 120_000,
      run: async (input, context, signal) => {
        const current = await latestContract(projectData, context, signal);
        if (current.test?.browser === undefined) {
          return { ok: false, passed: false, summary: 'Execution contract has no browser tests' };
        }
        const output = BrowserTestsPortOutputSchema.parse(
          await browser.runBrowserTests(
            { ...input, command: current.test.browser, workspaceRoot: current.workspace_root },
            mutationContext(context, 'run_browser_tests'),
            signal,
          ),
        );
        return { ...output, ok: output.passed };
      },
      userSummary: (_input, output) =>
        output.passed ? 'Browser tests passed' : 'Browser tests failed',
      auditPayload: (_input, output) => ({ passed: output.passed }),
    }),
    executionTool({
      name: 'capture_screenshot',
      description: 'Capture browser evidence for an attributed target and relative route.',
      inputSchema: CaptureScreenshotInputSchema,
      outputSchema: ScreenshotOutputSchema,
      idempotent: false,
      timeoutMs: 60_000,
      run: async (input, context, signal) => ({
        ok: true,
        ...ScreenshotPortOutputSchema.parse(
          await browser.captureScreenshot(
            input,
            mutationContext(context, 'capture_screenshot'),
            signal,
          ),
        ),
      }),
      userSummary: (input) => `Captured screenshot ${input.name}`,
      auditPayload: (input, output) => ({ name: input.name, artifactId: output.artifactId }),
    }),
    executionTool({
      name: 'inspect_browser_console',
      description: 'Read browser console evidence for an attributed target and relative route.',
      inputSchema: BrowserTargetInputSchema,
      outputSchema: ConsoleOutputSchema,
      idempotent: true,
      timeoutMs: 30_000,
      run: async (input, context, signal) => ({
        ok: true,
        ...ConsolePortOutputSchema.parse(
          await browser.inspectConsole(
            input,
            mutationContext(context, 'inspect_browser_console'),
            signal,
          ),
        ),
      }),
      userSummary: (_input, output) =>
        `Read ${String(output.entries.length)} browser console entries`,
      auditPayload: (_input, output) => ({ count: output.entries.length }),
    }),
    executionTool({
      name: 'inspect_network_requests',
      description: 'Read browser network evidence for an attributed target and relative route.',
      inputSchema: BrowserTargetInputSchema,
      outputSchema: NetworkOutputSchema,
      idempotent: true,
      timeoutMs: 30_000,
      run: async (input, context, signal) => ({
        ok: true,
        ...NetworkPortOutputSchema.parse(
          await browser.inspectNetwork(
            input,
            mutationContext(context, 'inspect_network_requests'),
            signal,
          ),
        ),
      }),
      userSummary: (_input, output) =>
        `Read ${String(output.requests.length)} browser network requests`,
      auditPayload: (_input, output) => ({ count: output.requests.length }),
    }),
  ];
}
