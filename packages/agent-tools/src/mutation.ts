import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { z } from 'zod';
import type { AnyToolSpec, ToolSpec } from './registry.js';

const pathSchema = z.string().min(1);
const attributionFields = {
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
} as const;

const ExecuteMigrationInputSchema = z
  .object({
    ...attributionFields,
    environmentId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    migration: z.string().min(1),
  })
  .strict();
const ExecuteMigrationOutputSchema = z
  .object({
    ok: z.literal(true),
    migrationId: z.string().min(1),
    status: z.enum(['applied', 'rejected']),
  })
  .strict();
const SetEnvironmentVariableInputSchema = z
  .object({
    ...attributionFields,
    environmentId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
    value: z.string(),
    scope: z.enum(['preview', 'staging', 'production']),
  })
  .strict();
const SetEnvironmentVariableOutputSchema = z
  .object({
    ok: z.literal(true),
    updated: z.boolean(),
    name: z.string().min(1),
    scope: z.enum(['preview', 'staging', 'production']),
  })
  .strict();

export interface MigrationPort {
  executeMigration(input: z.infer<typeof ExecuteMigrationInputSchema>): Promise<unknown>;
}

export interface EnvironmentPort {
  setEnvironmentVariable(
    input: z.infer<typeof SetEnvironmentVariableInputSchema>,
  ): Promise<unknown>;
}

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

function mutationTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  spec: Omit<ToolSpec<I, O>, 'classification' | 'approvalPolicy' | 'retryPolicy'>,
): AnyToolSpec {
  return {
    ...spec,
    classification: 'mutating',
    approvalPolicy: 'policy',
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
  } as unknown as AnyToolSpec;
}

interface PatchHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newCount: number;
  readonly lines: readonly string[];
}

interface PatchedFile {
  readonly path: string;
  readonly hunks: readonly PatchHunk[];
}

class PatchConflictError extends Error {}

function patchPath(header: string, prefix: '--- ' | '+++ '): string {
  const raw = header.slice(prefix.length).split('\t', 1)[0];
  if (raw === undefined || raw === '/dev/null') {
    throw new PatchConflictError('Unsupported patch target');
  }
  return raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
}

function parseUnifiedPatch(patch: string): PatchedFile[] {
  const lines = patch.split('\n');
  const files: PatchedFile[] = [];
  let index = 0;

  while (index < lines.length) {
    if (lines[index] === '') {
      index += 1;
      continue;
    }
    const oldHeader = lines[index];
    const newHeader = lines[index + 1];
    if (
      oldHeader === undefined ||
      !oldHeader.startsWith('--- ') ||
      newHeader === undefined ||
      !newHeader.startsWith('+++ ')
    ) {
      throw new PatchConflictError('Invalid unified patch header');
    }
    const oldPath = patchPath(oldHeader, '--- ');
    const newPath = patchPath(newHeader, '+++ ');
    if (oldPath !== newPath) {
      throw new PatchConflictError('Rename patches are not supported');
    }
    index += 2;
    const hunks: PatchHunk[] = [];

    while (index < lines.length && lines[index]?.startsWith('@@ ')) {
      const header = lines[index];
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(header ?? '');
      if (match === null) {
        throw new PatchConflictError('Invalid unified patch hunk');
      }
      const oldStart = Number(match[1]);
      const oldCount = Number(match[2] ?? '1');
      const newCount = Number(match[4] ?? '1');
      index += 1;
      const hunkLines: string[] = [];
      let seenOld = 0;
      let seenNew = 0;
      while (index < lines.length) {
        const line = lines[index];
        if (line === undefined || line.startsWith('@@ ') || line.startsWith('--- ')) break;
        if (line.startsWith('\\ No newline at end of file')) {
          index += 1;
          continue;
        }
        const prefix = line[0];
        if (prefix !== ' ' && prefix !== '+' && prefix !== '-') break;
        hunkLines.push(line);
        if (prefix !== '+') seenOld += 1;
        if (prefix !== '-') seenNew += 1;
        index += 1;
      }
      if (seenOld !== oldCount || seenNew !== newCount) {
        throw new PatchConflictError('Unified patch hunk counts do not match');
      }
      hunks.push({ oldStart, oldCount, newCount, lines: hunkLines });
    }
    if (hunks.length === 0) {
      throw new PatchConflictError('Patch target has no hunks');
    }
    files.push({ path: newPath, hunks });
  }

  if (files.length === 0) {
    throw new PatchConflictError('Patch has no files');
  }
  return files;
}

function applyHunks(content: string, file: PatchedFile): { content: string; hunksApplied: number } {
  const source = content.split('\n');
  const target: string[] = [];
  let cursor = 0;

  for (const hunk of file.hunks) {
    const hunkStart = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (hunkStart < cursor || hunkStart > source.length) {
      throw new PatchConflictError(`Patch context does not match ${file.path}`);
    }
    target.push(...source.slice(cursor, hunkStart));
    cursor = hunkStart;

    for (const line of hunk.lines) {
      const prefix = line[0];
      const text = line.slice(1);
      if (prefix === ' ' || prefix === '-') {
        if (source[cursor] !== text) {
          throw new PatchConflictError(`Patch context does not match ${file.path}`);
        }
        if (prefix === ' ') target.push(text);
        cursor += 1;
      } else {
        target.push(text);
      }
    }
  }

  target.push(...source.slice(cursor));
  return { content: target.join('\n'), hunksApplied: file.hunks.length };
}

export function createMutationTools(
  runtime: WorkspaceRuntime,
  migrations: MigrationPort,
  environment: EnvironmentPort,
): AnyToolSpec[] {
  const writeInput = z.object({ path: pathSchema, content: z.string() }).strict();
  const writeOutput = z
    .object({ ok: z.literal(true), path: z.string(), bytes: z.number().int().nonnegative() })
    .strict();
  const patchInput = z.object({ patch: z.string().min(1) }).strict();
  const patchOutput = z.union([
    z
      .object({
        ok: z.literal(true),
        filesChanged: z.number().int().positive(),
        hunksApplied: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        error: z.object({ code: z.literal('patch_conflict'), message: z.string().min(1) }).strict(),
      })
      .strict(),
  ]);
  const copyInput = z.object({ source: pathSchema, destination: pathSchema }).strict();
  const copyOutput = z
    .object({
      ok: z.literal(true),
      source: z.string(),
      destination: z.string(),
      bytes: z.number().int().nonnegative(),
    })
    .strict();
  const renameInput = copyInput;
  const renameOutput = z
    .object({ ok: z.literal(true), source: z.string(), destination: z.string() })
    .strict();
  const deleteInput = z.object({ path: pathSchema }).strict();
  const deleteOutput = z.object({ ok: z.literal(true), path: z.string() }).strict();
  const installInput = z
    .object({
      packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']),
      packages: z
        .array(
          z
            .string()
            .min(1)
            .refine((value) => !value.startsWith('-')),
        )
        .min(1)
        .max(100),
      dev: z.boolean().default(false),
      cwd: pathSchema.optional(),
    })
    .strict();

  return [
    mutationTool({
      name: 'write_file',
      description: 'Write one UTF-8 workspace file.',
      inputSchema: writeInput,
      outputSchema: writeOutput,
      riskLevel: 'medium',
      idempotent: true,
      timeoutMs: 30_000,
      redactOutput: false,
      run: async (input) => {
        const data = new TextEncoder().encode(input.content);
        await runtime.writeFile(input.path, data);
        return { ok: true, path: input.path, bytes: data.byteLength };
      },
      userSummary: (input) => `Wrote ${input.path}`,
      auditPayload: (input, output) => ({ path: input.path, bytes: output.bytes }),
    }),
    mutationTool({
      name: 'apply_patch',
      description: 'Apply a validated unified diff to workspace files.',
      inputSchema: patchInput,
      outputSchema: patchOutput,
      riskLevel: 'medium',
      idempotent: false,
      timeoutMs: 30_000,
      redactOutput: false,
      run: async (input) => {
        try {
          const files = parseUnifiedPatch(input.patch);
          const staged: Array<{ path: string; data: Uint8Array; hunks: number }> = [];
          for (const file of files) {
            const current = new TextDecoder().decode(await runtime.readFile(file.path));
            const applied = applyHunks(current, file);
            staged.push({
              path: file.path,
              data: new TextEncoder().encode(applied.content),
              hunks: applied.hunksApplied,
            });
          }
          for (const file of staged) {
            await runtime.writeFile(file.path, file.data);
          }
          return {
            ok: true,
            filesChanged: staged.length,
            hunksApplied: staged.reduce((total, file) => total + file.hunks, 0),
          };
        } catch (error: unknown) {
          if (error instanceof PatchConflictError) {
            return { ok: false, error: { code: 'patch_conflict', message: error.message } };
          }
          throw error;
        }
      },
      userSummary: (_input, output) =>
        output.ok
          ? `Applied ${String(output.hunksApplied)} hunks across ${String(output.filesChanged)} files`
          : 'Patch failed: context conflict',
      auditPayload: (_input, output) =>
        output.ok
          ? { ok: true, filesChanged: output.filesChanged, hunksApplied: output.hunksApplied }
          : { ok: false, errorCode: output.error.code },
    }),
    mutationTool({
      name: 'copy_file',
      description: 'Copy a workspace file through the runtime.',
      inputSchema: copyInput,
      outputSchema: copyOutput,
      riskLevel: 'medium',
      idempotent: true,
      timeoutMs: 30_000,
      redactOutput: false,
      run: async (input) => {
        const data = await runtime.readFile(input.source);
        await runtime.writeFile(input.destination, data);
        return {
          ok: true,
          source: input.source,
          destination: input.destination,
          bytes: data.byteLength,
        };
      },
      userSummary: (input) => `Copied ${input.source} to ${input.destination}`,
      auditPayload: (input, output) => ({
        source: input.source,
        destination: input.destination,
        bytes: output.bytes,
      }),
    }),
    mutationTool({
      name: 'rename_file',
      description: 'Rename a workspace file through runtime file operations.',
      inputSchema: renameInput,
      outputSchema: renameOutput,
      riskLevel: 'medium',
      idempotent: false,
      timeoutMs: 30_000,
      redactOutput: false,
      run: async (input) => {
        const data = await runtime.readFile(input.source);
        await runtime.writeFile(input.destination, data);
        await runtime.delete(input.source);
        return { ok: true, source: input.source, destination: input.destination };
      },
      userSummary: (input) => `Renamed ${input.source} to ${input.destination}`,
      auditPayload: (input) => ({ source: input.source, destination: input.destination }),
    }),
    mutationTool({
      name: 'delete_file',
      description: 'Delete a workspace path through the runtime.',
      inputSchema: deleteInput,
      outputSchema: deleteOutput,
      riskLevel: 'medium',
      idempotent: true,
      timeoutMs: 30_000,
      redactOutput: false,
      run: async (input) => {
        await runtime.delete(input.path);
        return { ok: true, path: input.path };
      },
      userSummary: (input) => `Deleted ${input.path}`,
      auditPayload: (input) => ({ path: input.path }),
    }),
    mutationTool({
      name: 'install_dependency',
      description: 'Install validated package names without a shell.',
      inputSchema: installInput,
      outputSchema: ExecOutputSchema,
      riskLevel: 'medium',
      idempotent: true,
      timeoutMs: 120_000,
      redactOutput: true,
      run: async (input) => {
        const base = input.packageManager === 'npm' ? ['install'] : ['add'];
        const devFlag = input.dev
          ? input.packageManager === 'npm' || input.packageManager === 'pnpm'
            ? ['--save-dev']
            : ['--dev']
          : [];
        return execOutput(
          await runtime.exec({
            cmd: input.packageManager,
            args: [...base, ...devFlag, '--', ...input.packages],
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            timeoutMs: 120_000,
          }),
        );
      },
      userSummary: (input, output) =>
        output.ok
          ? `Installed ${String(input.packages.length)} dependencies`
          : `Dependency installation failed (exit ${String(output.exitCode)})`,
      auditPayload: (input, output) => ({
        packageManager: input.packageManager,
        count: input.packages.length,
        ok: output.ok,
      }),
    }),
    mutationTool({
      name: 'execute_migration',
      description: 'Execute an attributed migration through the migration service.',
      inputSchema: ExecuteMigrationInputSchema,
      outputSchema: ExecuteMigrationOutputSchema,
      riskLevel: 'high',
      idempotent: true,
      timeoutMs: 120_000,
      redactOutput: true,
      run: (input) => migrations.executeMigration(input),
      userSummary: (input, output) =>
        `Migration ${output.migrationId} ${output.status} in ${input.environmentId}`,
      auditPayload: (input, output) => ({
        projectId: input.projectId,
        environmentId: input.environmentId,
        migrationId: output.migrationId,
        status: output.status,
      }),
    }),
    mutationTool({
      name: 'set_environment_variable',
      description: 'Set an environment variable through the secret-owning service.',
      inputSchema: SetEnvironmentVariableInputSchema,
      outputSchema: SetEnvironmentVariableOutputSchema,
      riskLevel: 'high',
      idempotent: true,
      timeoutMs: 30_000,
      redactOutput: true,
      run: (input) => environment.setEnvironmentVariable(input),
      userSummary: (input, output) =>
        output.updated
          ? `Updated ${input.name} in ${input.scope}`
          : `${input.name} was already current in ${input.scope}`,
      auditPayload: (input, output) => ({
        projectId: input.projectId,
        environmentId: input.environmentId,
        name: input.name,
        scope: input.scope,
        updated: output.updated,
      }),
    }),
  ];
}
