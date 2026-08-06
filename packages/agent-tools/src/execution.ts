import { ExecutionContractSchema } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { z } from 'zod';
import type { AnyToolSpec, ToolSpec } from './registry.js';

const attributionFields = {
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
} as const;
const RunBrowserTestsInputSchema = z
  .object({ ...attributionFields, baseUrl: z.string().url() })
  .strict();
const CaptureScreenshotInputSchema = z
  .object({ ...attributionFields, url: z.string().url(), name: z.string().min(1) })
  .strict();
const InspectBrowserInputSchema = z
  .object({ ...attributionFields, sessionId: z.string().min(1) })
  .strict();

const BrowserTestsOutputSchema = z
  .object({ ok: z.literal(true), passed: z.boolean(), summary: z.string() })
  .strict();
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

export interface BrowserEvidencePort {
  runBrowserTests(input: z.infer<typeof RunBrowserTestsInputSchema>): Promise<unknown>;
  captureScreenshot(input: z.infer<typeof CaptureScreenshotInputSchema>): Promise<unknown>;
  inspectConsole(input: z.infer<typeof InspectBrowserInputSchema>): Promise<unknown>;
  inspectNetwork(input: z.infer<typeof InspectBrowserInputSchema>): Promise<unknown>;
}

const CommandInputSchema = z
  .object({
    cmd: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string()).optional(),
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
const DevServerInputSchema = z.object({ contract: ExecutionContractSchema }).strict();
const DevServerOutputSchema = z
  .object({
    ok: z.literal(true),
    port: z.number().int().positive(),
    pid: z.number().int().positive(),
  })
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
      ...(input.env === undefined ? {} : { env: input.env }),
      timeoutMs: input.timeoutMs ?? 120_000,
    }),
  );
}

function commandSummary(label: string, output: z.infer<typeof ExecOutputSchema>): string {
  return output.ok ? `${label} completed` : `${label} failed (exit ${String(output.exitCode)})`;
}

function commandAudit(
  input: z.infer<typeof CommandInputSchema>,
  output: z.infer<typeof ExecOutputSchema>,
) {
  return {
    command: input.cmd,
    argumentCount: input.args.length,
    exitCode: output.exitCode,
    ok: output.ok,
  };
}

export function createExecutionTools(
  runtime: WorkspaceRuntime,
  browser: BrowserEvidencePort,
): AnyToolSpec[] {
  const commandSpecs = [
    ['run_command', 'Run command', 'Command'] as const,
    ['run_build', 'Run the project build command', 'Build'] as const,
    ['run_typecheck', 'Run the project typecheck command', 'Typecheck'] as const,
    ['run_lint', 'Run the project lint command', 'Lint'] as const,
    ['run_unit_tests', 'Run the project unit-test command', 'Unit tests'] as const,
    [
      'run_integration_tests',
      'Run the project integration-test command',
      'Integration tests',
    ] as const,
  ];
  const commandTools = new Map(
    commandSpecs.map(([name, description, label]) => [
      name,
      executionTool({
        name,
        description,
        inputSchema: CommandInputSchema,
        outputSchema: ExecOutputSchema,
        idempotent: false,
        timeoutMs: 120_000,
        run: (input) => runCommand(runtime, input),
        userSummary: (_input, output) => commandSummary(label, output),
        auditPayload: commandAudit,
      }),
    ]),
  );
  const requiredCommand = (name: (typeof commandSpecs)[number][0]): AnyToolSpec => {
    const tool = commandTools.get(name);
    if (tool === undefined) throw new Error(`Missing execution tool ${name}`);
    return tool;
  };

  return [
    requiredCommand('run_command'),
    executionTool({
      name: 'run_dev_server',
      description: 'Start the project development server through the workspace runtime.',
      inputSchema: DevServerInputSchema,
      outputSchema: DevServerOutputSchema,
      idempotent: false,
      timeoutMs: 30_000,
      run: async (input) => ({ ok: true, ...(await runtime.startDevServer(input.contract)) }),
      userSummary: (_input, output) => `Started development server on port ${String(output.port)}`,
      auditPayload: (_input, output) => ({ port: output.port, pid: output.pid }),
    }),
    executionTool({
      name: 'restart_dev_server',
      description: 'Restart the supervised project development server.',
      inputSchema: DevServerInputSchema,
      outputSchema: DevServerOutputSchema,
      idempotent: false,
      timeoutMs: 30_000,
      run: async (input) => ({ ok: true, ...(await runtime.startDevServer(input.contract)) }),
      userSummary: (_input, output) =>
        `Restarted development server on port ${String(output.port)}`,
      auditPayload: (_input, output) => ({ port: output.port, pid: output.pid }),
    }),
    requiredCommand('run_build'),
    requiredCommand('run_typecheck'),
    requiredCommand('run_lint'),
    requiredCommand('run_unit_tests'),
    requiredCommand('run_integration_tests'),
    executionTool({
      name: 'run_browser_tests',
      description: 'Run attributed browser tests through the browser-evidence service.',
      inputSchema: RunBrowserTestsInputSchema,
      outputSchema: BrowserTestsOutputSchema,
      idempotent: true,
      timeoutMs: 120_000,
      run: (input) => browser.runBrowserTests(input),
      userSummary: (_input, output) =>
        output.passed ? 'Browser tests passed' : 'Browser tests failed',
      auditPayload: (input, output) => ({
        projectId: input.projectId,
        runId: input.runId,
        passed: output.passed,
      }),
    }),
    executionTool({
      name: 'capture_screenshot',
      description: 'Capture attributed browser evidence through the browser service.',
      inputSchema: CaptureScreenshotInputSchema,
      outputSchema: ScreenshotOutputSchema,
      idempotent: true,
      timeoutMs: 60_000,
      run: (input) => browser.captureScreenshot(input),
      userSummary: (input) => `Captured screenshot ${input.name}`,
      auditPayload: (input, output) => ({
        projectId: input.projectId,
        runId: input.runId,
        name: input.name,
        artifactId: output.artifactId,
      }),
    }),
    executionTool({
      name: 'inspect_browser_console',
      description: 'Read attributed browser console evidence.',
      inputSchema: InspectBrowserInputSchema,
      outputSchema: ConsoleOutputSchema,
      idempotent: true,
      timeoutMs: 30_000,
      run: (input) => browser.inspectConsole(input),
      userSummary: (_input, output) =>
        `Read ${String(output.entries.length)} browser console entries`,
      auditPayload: (input, output) => ({
        projectId: input.projectId,
        runId: input.runId,
        count: output.entries.length,
      }),
    }),
    executionTool({
      name: 'inspect_network_requests',
      description: 'Read attributed browser network evidence.',
      inputSchema: InspectBrowserInputSchema,
      outputSchema: NetworkOutputSchema,
      idempotent: true,
      timeoutMs: 30_000,
      run: (input) => browser.inspectNetwork(input),
      userSummary: (_input, output) =>
        `Read ${String(output.requests.length)} browser network requests`,
      auditPayload: (input, output) => ({
        projectId: input.projectId,
        runId: input.runId,
        count: output.requests.length,
      }),
    }),
  ];
}
