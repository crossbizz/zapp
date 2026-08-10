import { RouteSchema, type Route } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import ts from 'typescript';
import { z } from 'zod';

export interface GeneratedPlaywrightSpec {
  readonly path: `e2e/zapp/${string}.spec.ts`;
  readonly source: string;
}

export interface CommittedGeneratedPlaywrightSpec extends GeneratedPlaywrightSpec {
  readonly commitSha: string;
}

const GeneratedSpecOperationKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u);
const SmokeGenerationInputSchema = z
  .object({
    operationKey: GeneratedSpecOperationKeySchema,
    routes: z.array(RouteSchema).max(10_000).readonly(),
  })
  .strict()
  .readonly();

export type SmokeGenerationInput = z.input<typeof SmokeGenerationInputSchema>;

export interface SmokeSpecGenerator {
  generate(input: SmokeGenerationInput): Promise<CommittedGeneratedPlaywrightSpec>;
}

export class GeneratedPlaywrightPolicyError extends Error {
  public constructor(readonly violations: readonly string[]) {
    super(`Generated Playwright policy violation: ${violations.join(', ')}`);
    this.name = 'GeneratedPlaywrightPolicyError';
  }
}

const generatedSpecLockPath = '.git/zapp-generated-spec.lock';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function withGeneratedSpecRepositoryLock<Result>(
  runtime: WorkspaceRuntime,
  action: () => Promise<Result>,
): Promise<Result> {
  const deadline = Date.now() + 300_000;
  for (;;) {
    const acquired = await runtime.exec({
      cmd: 'mkdir',
      args: [generatedSpecLockPath],
      timeoutMs: 10_000,
    });
    if (acquired.exitCode === 0) break;
    if (Date.now() >= deadline) throw new Error('generated_spec_repository_lock_timeout');
    await delay(25);
  }

  let result: Result | undefined;
  let actionError: Error | undefined;
  try {
    result = await action();
  } catch (error: unknown) {
    actionError =
      error instanceof Error
        ? error
        : new Error('generated_spec_repository_action_failed', { cause: error });
  }
  const released = await runtime.exec({
    cmd: 'rmdir',
    args: [generatedSpecLockPath],
    timeoutMs: 10_000,
  });
  if (actionError !== undefined) throw actionError;
  if (released.exitCode !== 0) throw new Error('generated_spec_repository_unlock_failed');
  return result as Result;
}

export async function ensureGeneratedSpecDirectory(runtime: WorkspaceRuntime): Promise<void> {
  const result = await runtime.exec({
    cmd: 'mkdir',
    args: ['-p', 'e2e/zapp'],
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) throw new Error('generated_spec_directory_failed');
}

export async function assertGeneratedSpecIndexClean(runtime: WorkspaceRuntime): Promise<void> {
  const staged = await runtime.git({
    operation: 'diff',
    args: ['--cached', '--name-only'],
  });
  if (staged.exitCode !== 0) throw new Error('generated_spec_index_status_failed');
  if (staged.stdout.trim().length > 0) throw new Error('generated_spec_requires_clean_index');
}

function operationMarker(operationKey: string): string {
  return `[zapp-op:${operationKey}]`;
}

async function fullCommitIdentity(runtime: WorkspaceRuntime, revision: string): Promise<string> {
  const shown = await runtime.git({ operation: 'show', args: ['--name-only', revision] });
  const commitSha = /^commit ([a-f0-9]{40})$/imu.exec(shown.stdout)?.[1];
  if (shown.exitCode !== 0 || commitSha === undefined) {
    throw new Error('generated_spec_commit_identity_failed');
  }
  return commitSha;
}

export async function findCommittedGeneratedSpec(
  runtime: WorkspaceRuntime,
  operationKey: string,
  path: `e2e/zapp/${string}.spec.ts`,
): Promise<CommittedGeneratedPlaywrightSpec | undefined> {
  const marker = operationMarker(operationKey);
  const candidates = await runtime.git({ operation: 'log', args: ['--oneline'] });
  if (candidates.exitCode !== 0) throw new Error('generated_spec_receipt_lookup_failed');
  for (const line of candidates.stdout.split('\n').map((value) => value.trim()).filter(Boolean)) {
    const separator = line.indexOf(' ');
    if (separator < 1 || !line.slice(separator + 1).endsWith(marker)) continue;
    const commitSha = await fullCommitIdentity(runtime, line.slice(0, separator));
    const stored = await runtime.git({ operation: 'show', args: [`${commitSha}:${path}`] });
    if (stored.exitCode !== 0) throw new Error('generated_spec_receipt_missing_file');
    assertDeterministicPlaywright(stored.stdout);
    return { path, source: stored.stdout, commitSha };
  }
  return undefined;
}

export async function commitGeneratedSpecPaths(
  runtime: WorkspaceRuntime,
  input: {
    readonly operationKey: string;
    readonly path: `e2e/zapp/${string}.spec.ts`;
    readonly paths: readonly string[];
    readonly subject: string;
  },
): Promise<CommittedGeneratedPlaywrightSpec> {
  const result = await runtime.git({
    operation: 'add_commit',
    paths: [...new Set(input.paths)].sort(),
    message: `${input.subject} ${operationMarker(input.operationKey)}`,
  });
  if (result.exitCode !== 0) throw new Error('generated_spec_commit_failed');
  const committed = await findCommittedGeneratedSpec(runtime, input.operationKey, input.path);
  if (committed === undefined) throw new Error('generated_spec_commit_identity_failed');
  return committed;
}

const networkIdleMethods = new Set([
  'goto',
  'reload',
  'setContent',
  'waitForLoadState',
  'waitForNavigation',
  'waitForURL',
]);

function calledMethod(node: ts.CallExpression): string | undefined {
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  if (!ts.isElementAccessExpression(node.expression)) return undefined;
  const argument = node.expression.argumentExpression;
  return ts.isStringLiteral(argument) ? argument.text : undefined;
}

function containsNetworkIdle(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (ts.isStringLiteralLike(child) && child.text === 'networkidle') {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

export function assertDeterministicPlaywright(source: string): void {
  const file = ts.createSourceFile(
    'generated.spec.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.Latest },
    fileName: 'generated.spec.ts',
    reportDiagnostics: true,
  }).diagnostics;
  if (diagnostics !== undefined && diagnostics.length > 0) {
    throw new GeneratedPlaywrightPolicyError(['invalid TypeScript']);
  }

  const violations = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const method = calledMethod(node);
      if (method === 'waitForTimeout') violations.add('waitForTimeout');
      if (
        method !== undefined &&
        networkIdleMethods.has(method) &&
        node.arguments.some(containsNetworkIdle)
      ) {
        violations.add('networkidle');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (violations.size > 0) {
    throw new GeneratedPlaywrightPolicyError([...violations].sort());
  }
}

function quoted(value: string): string {
  return `'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')}'`;
}

function smokeCase(path: string): string {
  return `test(${quoted(`smoke: ${path}`)}, async ({ page }) => {
  await page.goto(${quoted(path)});
  await expect(page).toHaveTitle(/.+/);
  await expect(page.locator('#root, #__next, main, body > *').first()).toBeVisible();
});`;
}

export function generateSmokeSpec(rawRoutes: readonly Route[]): GeneratedPlaywrightSpec {
  const paths = [
    ...new Set(
      rawRoutes
        .map((route) => RouteSchema.parse(route))
        .filter((route) => route.kind === 'page' && !route.dynamic)
        .map((route) => route.path),
    ),
  ].sort((left, right) => (left === '/' ? -1 : right === '/' ? 1 : left.localeCompare(right)));
  const cases = paths.map(smokeCase).join('\n\n');
  const source = `import { expect, test } from '@playwright/test';

const consoleErrors = new WeakMap<object, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  consoleErrors.set(page, errors);
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterEach(({ page }) => {
  expect(consoleErrors.get(page), 'uncaught browser errors').toEqual([]);
});

${cases}
`;
  assertDeterministicPlaywright(source);
  return { path: 'e2e/zapp/smoke.spec.ts', source };
}

export function createSmokeSpecGenerator(dependencies: {
  readonly runtime: WorkspaceRuntime;
}): SmokeSpecGenerator {
  return {
    generate(rawInput) {
      const input = SmokeGenerationInputSchema.parse(rawInput);
      return withGeneratedSpecRepositoryLock(dependencies.runtime, async () => {
        const path = 'e2e/zapp/smoke.spec.ts' as const;
        const replay = await findCommittedGeneratedSpec(
          dependencies.runtime,
          input.operationKey,
          path,
        );
        if (replay !== undefined) return replay;
        await assertGeneratedSpecIndexClean(dependencies.runtime);
        const generated = generateSmokeSpec(input.routes);
        await ensureGeneratedSpecDirectory(dependencies.runtime);
        await dependencies.runtime.writeFile(path, new TextEncoder().encode(generated.source));
        return commitGeneratedSpecPaths(dependencies.runtime, {
          operationKey: input.operationKey,
          path,
          paths: [path],
          subject: 'test: add generated smoke coverage',
        });
      });
    },
  };
}
