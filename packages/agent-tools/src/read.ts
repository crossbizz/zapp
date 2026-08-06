import { ExecutionContractSchema } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { z } from 'zod';
import type { AnyToolSpec, ToolExecutionContext, ToolSpec } from './registry.js';

const pathSchema = z.string().min(1);

const ReadLogsInputSchema = z
  .object({
    source: z.string().min(1).optional(),
    limit: z.number().int().positive().max(1_000).default(100),
  })
  .strict();
const ReadTestResultsInputSchema = z
  .object({
    suite: z.enum(['unit', 'integration', 'browser', 'all']).default('all'),
  })
  .strict();
const ReadDatabaseSchemaInputSchema = z
  .object({ environmentId: z.string().min(1) })
  .strict();
const ReadProjectContractInputSchema = z.object({}).strict();

const LogsOutputSchema = z
  .object({
    ok: z.literal(true),
    entries: z.array(
      z
        .object({
          timestamp: z.string().min(1),
          level: z.string().min(1),
          message: z.string(),
        })
        .strict(),
    ),
    truncated: z.boolean(),
  })
  .strict();
const TestResultsPortOutputSchema = z
  .object({
    status: z.enum(['passed', 'failed', 'running', 'not_run']),
    summary: z.string(),
    artifactId: z.string().min(1).optional(),
  })
  .strict();
const TestResultsOutputSchema = z.union([
  TestResultsPortOutputSchema.extend({ ok: z.literal(true), status: z.literal('passed') }).strict(),
  TestResultsPortOutputSchema.extend({
    ok: z.literal(false),
    status: z.enum(['failed', 'running', 'not_run']),
  }).strict(),
]);
const DatabaseSchemaOutputSchema = z
  .object({ ok: z.literal(true), dialect: z.string().min(1), schema: z.string() })
  .strict();
const ProjectContractOutputSchema = z
  .object({
    ok: z.literal(true),
    version: z.number().int().positive(),
    contract: ExecutionContractSchema,
  })
  .strict();

export interface ProjectDataPort {
  readLogs(
    input: z.infer<typeof ReadLogsInputSchema>,
    context: ToolExecutionContext,
    signal: AbortSignal,
  ): Promise<unknown>;
  readTestResults(
    input: z.infer<typeof ReadTestResultsInputSchema>,
    context: ToolExecutionContext,
    signal: AbortSignal,
  ): Promise<unknown>;
  readDatabaseSchema(
    input: z.infer<typeof ReadDatabaseSchemaInputSchema>,
    context: ToolExecutionContext,
    signal: AbortSignal,
  ): Promise<unknown>;
  readLatestProjectContract(
    context: ToolExecutionContext,
    signal: AbortSignal,
  ): Promise<unknown>;
}

function readTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  spec: Omit<
    ToolSpec<I, O>,
    'classification' | 'riskLevel' | 'approvalPolicy' | 'idempotent' | 'retryPolicy'
  >,
): AnyToolSpec {
  return {
    ...spec,
    classification: 'read_only',
    riskLevel: 'low',
    approvalPolicy: 'auto',
    idempotent: true,
    retryPolicy: { maxAttempts: 2, backoffMs: 1 },
  } as unknown as AnyToolSpec;
}

const FileEntrySchema = z
  .object({ path: z.string(), type: z.enum(['file', 'directory', 'symlink']) })
  .strict();
const FileStatSchema = FileEntrySchema.extend({
  size: z.number().nonnegative(),
  mtimeMs: z.number().nonnegative(),
}).strict();
const SearchOutputSchema = z
  .object({
    ok: z.boolean(),
    exitCode: z.number().int(),
    matches: z.array(z.string()),
    stderr: z.string(),
    truncated: z.boolean(),
  })
  .strict();
const GitReadOutputSchema = z
  .object({ ok: z.boolean(), exitCode: z.number().int(), stdout: z.string(), stderr: z.string() })
  .strict();

function searchResult(
  result: Awaited<ReturnType<WorkspaceRuntime['exec']>>,
): z.infer<typeof SearchOutputSchema> {
  return {
    ok: result.exitCode === 0 || result.exitCode === 1,
    exitCode: result.exitCode,
    matches: result.stdout.split('\n').filter((line) => line.length > 0),
    stderr: result.stderr,
    truncated: result.truncated,
  };
}

function gitResult(
  result: Awaited<ReturnType<WorkspaceRuntime['git']>>,
): z.infer<typeof GitReadOutputSchema> {
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function createReadTools(
  runtime: WorkspaceRuntime,
  projectData: ProjectDataPort,
): AnyToolSpec[] {
  const readFileInput = z.object({ path: pathSchema }).strict();
  const readFileOutput = z
    .object({
      ok: z.literal(true),
      path: z.string(),
      content: z.string(),
      encoding: z.literal('utf8'),
    })
    .strict();
  const listFilesInput = z
    .object({
      path: pathSchema.default('.'),
      glob: z.string().min(1).optional(),
      maxDepth: z.number().int().nonnegative().max(100).optional(),
    })
    .strict();
  const listFilesOutput = z
    .object({ ok: z.literal(true), entries: z.array(FileEntrySchema) })
    .strict();
  const fileStatsInput = z.object({ path: pathSchema }).strict();
  const fileStatsOutput = z.object({ ok: z.literal(true), entry: FileStatSchema }).strict();
  const searchInput = z
    .object({
      query: z.string().min(1),
      path: pathSchema.default('.'),
      glob: z.string().min(1).optional(),
    })
    .strict();
  const grepInput = z
    .object({
      pattern: z.string().min(1),
      path: pathSchema.default('.'),
      fixedStrings: z.boolean().default(false),
      ignoreCase: z.boolean().default(false),
    })
    .strict();
  const gitStatusInput = z.object({ short: z.boolean().default(true) }).strict();
  const gitDiffInput = z
    .object({
      cached: z.boolean().default(false),
      stat: z.boolean().default(false),
      path: pathSchema.optional(),
    })
    .strict();
  const gitLogInput = z
    .object({ maxCount: z.number().int().positive().max(1_000).default(50) })
    .strict();
  const gitShowInput = z
    .object({
      ref: z.string().min(1).refine((value) => !value.startsWith('-'), 'Git object cannot be an option'),
      stat: z.boolean().default(false),
    })
    .strict();

  return [
    readTool({
      name: 'read_file',
      description: 'Read one UTF-8 workspace file.',
      inputSchema: readFileInput,
      outputSchema: readFileOutput,
      timeoutMs: 30_000,
      redactOutput: true,
      run: async (input) => ({
        ok: true,
        path: input.path,
        content: new TextDecoder().decode(await runtime.readFile(input.path)),
        encoding: 'utf8',
      }),
      userSummary: (input) => `Read ${input.path}`,
      auditPayload: (input) => ({ path: input.path }),
    }),
    readTool({
      name: 'list_files',
      description: 'List workspace entries beneath a path.',
      inputSchema: listFilesInput,
      outputSchema: listFilesOutput,
      timeoutMs: 30_000,
      redactOutput: true,
      run: async (input) => ({
        ok: true,
        entries: await runtime.listFiles(input.path, {
          ...(input.glob === undefined ? {} : { glob: input.glob }),
          ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
        }),
      }),
      userSummary: (input, output) =>
        `Listed ${String(output.entries.length)} entries under ${input.path}`,
      auditPayload: (input, output) => ({ path: input.path, count: output.entries.length }),
    }),
    readTool({
      name: 'file_stats',
      description: 'Read workspace file metadata.',
      inputSchema: fileStatsInput,
      outputSchema: fileStatsOutput,
      timeoutMs: 30_000,
      redactOutput: false,
      run: async (input) => ({ ok: true, entry: await runtime.stat(input.path) }),
      userSummary: (input) => `Inspected ${input.path}`,
      auditPayload: (input, output) => ({ path: input.path, size: output.entry.size }),
    }),
    readTool({
      name: 'search_code',
      description: 'Search workspace code with ripgrep.',
      inputSchema: searchInput,
      outputSchema: SearchOutputSchema,
      timeoutMs: 30_000,
      redactOutput: true,
      run: async (input) => {
        await runtime.stat(input.path);
        const args = ['--line-number', '--color', 'never'];
        if (input.glob !== undefined) args.push('--glob', input.glob);
        args.push('--', input.query, input.path);
        return searchResult(await runtime.exec({ cmd: 'rg', args, timeoutMs: 30_000 }));
      },
      userSummary: (input, output) =>
        output.ok
          ? `Found ${String(output.matches.length)} matches for ${input.query}`
          : `Search for ${input.query} failed (exit ${String(output.exitCode)})`,
      auditPayload: (input, output) => ({
        query: input.query,
        matches: output.matches.length,
        ok: output.ok,
      }),
    }),
    readTool({
      name: 'grep',
      description: 'Search workspace text with ripgrep options.',
      inputSchema: grepInput,
      outputSchema: SearchOutputSchema,
      timeoutMs: 30_000,
      redactOutput: true,
      run: async (input) => {
        await runtime.stat(input.path);
        const args = ['--line-number', '--color', 'never'];
        if (input.fixedStrings) args.push('--fixed-strings');
        if (input.ignoreCase) args.push('--ignore-case');
        args.push('--', input.pattern, input.path);
        return searchResult(await runtime.exec({ cmd: 'rg', args, timeoutMs: 30_000 }));
      },
      userSummary: (input, output) =>
        output.ok
          ? `Found ${String(output.matches.length)} matches for ${input.pattern}`
          : `Grep for ${input.pattern} failed (exit ${String(output.exitCode)})`,
      auditPayload: (input, output) => ({
        pattern: input.pattern,
        matches: output.matches.length,
        ok: output.ok,
      }),
    }),
    readTool({
      name: 'git_status',
      description: 'Read workspace Git status.',
      inputSchema: gitStatusInput,
      outputSchema: GitReadOutputSchema,
      timeoutMs: 30_000,
      redactOutput: true,
      run: async (input) =>
        gitResult(await runtime.git({ operation: 'status', args: input.short ? ['--short'] : [] })),
      userSummary: (_input, output) =>
        output.ok ? 'Read Git status' : `Git status failed (exit ${String(output.exitCode)})`,
      auditPayload: (_input, output) => ({ ok: output.ok, exitCode: output.exitCode }),
    }),
    readTool({
      name: 'git_diff',
      description: 'Read a workspace Git diff.',
      inputSchema: gitDiffInput,
      outputSchema: GitReadOutputSchema,
      timeoutMs: 30_000,
      redactOutput: true,
      run: async (input) => {
        const args: string[] = [];
        if (input.cached) args.push('--cached');
        if (input.stat) args.push('--stat');
        if (input.path !== undefined) args.push('--', input.path);
        return gitResult(await runtime.git({ operation: 'diff', args }));
      },
      userSummary: (_input, output) =>
        output.ok ? 'Read Git diff' : `Git diff failed (exit ${String(output.exitCode)})`,
      auditPayload: (_input, output) => ({ ok: output.ok, exitCode: output.exitCode }),
    }),
    readTool({
      name: 'git_log',
      description: 'Read recent workspace commits.',
      inputSchema: gitLogInput,
      outputSchema: GitReadOutputSchema,
      timeoutMs: 30_000,
      redactOutput: true,
      run: async (input) => {
        const result = gitResult(await runtime.git({ operation: 'log', args: ['--oneline'] }));
        return { ...result, stdout: result.stdout.split('\n').slice(0, input.maxCount).join('\n') };
      },
      userSummary: (_input, output) =>
        output.ok ? 'Read Git log' : `Git log failed (exit ${String(output.exitCode)})`,
      auditPayload: (_input, output) => ({ ok: output.ok, exitCode: output.exitCode }),
    }),
    readTool({
      name: 'git_show',
      description: 'Read one Git object or commit.',
      inputSchema: gitShowInput,
      outputSchema: GitReadOutputSchema,
      timeoutMs: 30_000,
      redactOutput: true,
      run: async (input) =>
        gitResult(
          await runtime.git({
            operation: 'show',
            args: [...(input.stat ? ['--stat'] : []), input.ref],
          }),
        ),
      userSummary: (input, output) =>
        output.ok
          ? `Read Git object ${input.ref}`
          : `Git show failed for ${input.ref} (exit ${String(output.exitCode)})`,
      auditPayload: (input, output) => ({
        ref: input.ref,
        ok: output.ok,
        exitCode: output.exitCode,
      }),
    }),
    readTool({
      name: 'read_logs',
      description: 'Read attributed project logs through the project-data service.',
      inputSchema: ReadLogsInputSchema,
      outputSchema: LogsOutputSchema,
      timeoutMs: 30_000,
      redactOutput: true,
      run: (input, context, signal) => projectData.readLogs(input, context, signal),
      userSummary: (_input, output) => `Read ${String(output.entries.length)} log entries`,
      auditPayload: (_input, output) => ({ count: output.entries.length }),
    }),
    readTool({
      name: 'read_test_results',
      description: 'Read attributed test results through the project-data service.',
      inputSchema: ReadTestResultsInputSchema,
      outputSchema: TestResultsOutputSchema,
      timeoutMs: 30_000,
      redactOutput: true,
      run: async (input, context, signal) => {
        const output = TestResultsPortOutputSchema.parse(
          await projectData.readTestResults(input, context, signal),
        );
        return { ...output, ok: output.status === 'passed' };
      },
      userSummary: (_input, output) => `Read ${output.status} test results`,
      auditPayload: (_input, output) => ({ status: output.status }),
    }),
    readTool({
      name: 'read_database_schema',
      description: 'Read a project database schema through its tenant-aware service.',
      inputSchema: ReadDatabaseSchemaInputSchema,
      outputSchema: DatabaseSchemaOutputSchema,
      timeoutMs: 30_000,
      redactOutput: true,
      run: (input, context, signal) => projectData.readDatabaseSchema(input, context, signal),
      userSummary: (_input, output) => `Read ${output.dialect} database schema`,
      auditPayload: (input, output) => ({
        environmentId: input.environmentId,
        dialect: output.dialect,
      }),
    }),
    readTool({
      name: 'read_project_contract',
      description: 'Read the latest versioned project execution contract.',
      inputSchema: ReadProjectContractInputSchema,
      outputSchema: ProjectContractOutputSchema,
      timeoutMs: 30_000,
      redactOutput: true,
      run: (_input, context, signal) => projectData.readLatestProjectContract(context, signal),
      userSummary: (_input, output) => `Read project contract version ${String(output.version)}`,
      auditPayload: (_input, output) => ({ version: output.version }),
    }),
  ];
}
