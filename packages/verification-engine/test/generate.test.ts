import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Route } from '@zapp/contracts';
import { MemoryWorkspaceRuntime } from '@zapp/workspace-runtime';
import { describe, expect, test } from 'vitest';

import {
  assertDeterministicPlaywright,
  createAcceptanceSpecGenerator,
  createSmokeSpecGenerator,
  generateSmokeSpec,
} from '../src/index.js';

const routes = [
  { path: '/', kind: 'page', dynamic: false, sourceFile: 'app/page.tsx' },
  { path: '/settings', kind: 'page', dynamic: false, sourceFile: 'app/settings/page.tsx' },
  { path: '/api/health', kind: 'api', dynamic: false, sourceFile: 'app/api/health/route.ts' },
  {
    path: '/projects/[id]',
    kind: 'page',
    dynamic: true,
    sourceFile: 'app/projects/[id]/page.tsx',
  },
] satisfies readonly Route[];

const execFileAsync = promisify(execFile);

// These fixtures run sequences of independently bounded real Git processes.
// The outer envelope must not preempt per-command diagnostics under the full cold gate.
const REAL_GIT_FIXTURE_TIMEOUT_MS = 60_000;

async function git(root: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd: root })).stdout.trim();
}

async function initializeGit(root: string): Promise<string> {
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/SaveButton.tsx'), 'export function SaveButton() {}\n');
  await writeFile(join(root, 'src/ConfirmDialog.tsx'), 'export function ConfirmDialog() {}\n');
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'VF-8 fixture');
  await git(root, 'config', 'user.email', 'vf8@example.invalid');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'fixture: initial project');
  return git(root, 'rev-parse', 'HEAD');
}

describe('VF-8 deterministic Playwright generation', () => {
  test('generates the owned smoke spec from static discovered pages', () => {
    expect(generateSmokeSpec(routes)).toMatchInlineSnapshot(`
      {
        "path": "e2e/zapp/smoke.spec.ts",
        "source": "import { expect, test } from '@playwright/test';

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

      test('smoke: /', async ({ page }) => {
        await page.goto('/');
        await expect(page).toHaveTitle(/.+/);
        await expect(page.locator('#root, #__next, main, body > *').first()).toBeVisible();
      });

      test('smoke: /settings', async ({ page }) => {
        await page.goto('/settings');
        await expect(page).toHaveTitle(/.+/);
        await expect(page.locator('#root, #__next, main, body > *').first()).toBeVisible();
      });
      ",
      }
    `);
  });

  test('writes, commits, and replays the owned smoke spec with one operation key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-vf8-smoke-'));
    try {
      const initialCommit = await initializeGit(root);
      const generator = createSmokeSpecGenerator({
        runtime: new MemoryWorkspaceRuntime(root),
      });
      const input = { operationKey: 'vf8-smoke-generation-1', routes } as const;

      const generated = await generator.generate(input);

      expect(generated.path).toBe('e2e/zapp/smoke.spec.ts');
      expect(generated.commitSha).not.toBe(initialCommit);
      expect(generated.commitSha).toBe(await git(root, 'rev-parse', 'HEAD'));
      expect(await git(root, 'show', `${generated.commitSha}:${generated.path}`)).toBe(
        generated.source.trim(),
      );
      const replay = await generator.generate(input);
      expect(replay).toEqual(generated);
      expect(
        (await git(root, 'log', '--format=%s')).split('\n').filter((subject) =>
          subject.endsWith('[zapp-op:vf8-smoke-generation-1]'),
        ),
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, REAL_GIT_FIXTURE_TIMEOUT_MS);

  test.each([
    [
      'timeout sleeps',
      "test('bad', async ({ page }) => { await page.waitForTimeout(50); });",
      'waitForTimeout',
    ],
    [
      'network-idle navigation',
      "test('bad', async ({ page }) => { await page.goto('/', { waitUntil: 'networkidle' }); });",
      'networkidle',
    ],
    [
      'network-idle load waits',
      "test('bad', async ({ page }) => { await page.waitForLoadState('networkidle'); });",
      'networkidle',
    ],
  ])('rejects %s in generated specs', (_name, source, violation) => {
    expect(() => {
      assertDeterministicPlaywright(source);
    }).toThrow(violation);
  });

  test('does not reject banned words in comments or ordinary text', () => {
    expect(() => {
      assertDeterministicPlaywright(`
        // Never use page.waitForTimeout or networkidle here.
        test('copy', async ({ page }) => {
          await page.goto('/search?q=networkidle');
          await expect(page.getByText('waitForTimeout')).toBeVisible();
        });
      `);
    }).not.toThrow();
  });
});

describe('VF-8 acceptance generation', () => {
  test.each([
    ['the same operation key', 'vf8-concurrent-same', 'vf8-concurrent-same'],
    ['distinct operation keys', 'vf8-concurrent-a', 'vf8-concurrent-b'],
  ])('serializes concurrent generation for %s', async (_case, firstKey, secondKey) => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-vf8-concurrent-'));
    let activeSessions = 0;
    let maxActiveSessions = 0;
    let sessionCalls = 0;
    let releaseSecondSession!: () => void;
    const secondSessionStarted = new Promise<void>((resolve) => {
      releaseSecondSession = resolve;
    });
    try {
      await initializeGit(root);
      const runtime = new MemoryWorkspaceRuntime(root);
      const generator = createAcceptanceSpecGenerator({
        runtime,
        session: {
          async generate(input) {
            sessionCalls += 1;
            activeSessions += 1;
            maxActiveSessions = Math.max(maxActiveSessions, activeSessions);
            if (sessionCalls === 1) {
              await Promise.race([
                secondSessionStarted,
                new Promise<void>((resolve) => {
                  setTimeout(resolve, 50);
                }),
              ]);
            } else {
              releaseSecondSession();
            }
            const criterion = /Criterion:\n(AC-[0-9]+):/u.exec(input.prompt)?.[1] ?? 'AC-10';
            activeSessions -= 1;
            return {
              source: `// @zapp-criterion ${criterion}\nimport { test } from '@playwright/test';\n\ntest('[${criterion}] generated acceptance', async ({ page }) => {\n  await page.getByTestId('save-button').click();\n});\n`,
              requiredTestIds: [
                { componentPath: 'src/SaveButton.tsx', testId: 'save-button' },
              ],
            };
          },
        },
        codeEdits: {
          addTestId() {
            throw new Error('unexpected test-id edit');
          },
        },
      });
      const input = (operationKey: string, criterionId: 'AC-10' | 'AC-11') => ({
        operationKey,
        criterionId,
        acceptanceCriterion: `Complete ${criterionId}.`,
        routes,
        componentInventory: [{ path: 'src/SaveButton.tsx', testIds: ['save-button'] }],
      });

      const [first, second] = await Promise.all([
        generator.generate(input(firstKey, 'AC-10')),
        generator.generate(input(secondKey, firstKey === secondKey ? 'AC-10' : 'AC-11')),
      ]);

      expect(maxActiveSessions).toBe(1);
      expect(sessionCalls).toBe(firstKey === secondKey ? 1 : 2);
      if (firstKey === secondKey) expect(second).toEqual(first);
      for (const generated of [first, second]) {
        expect(await git(root, 'show', `${generated.commitSha}:${generated.path}`)).toBe(
          generated.source.trim(),
        );
      }
      const markers = (await git(root, 'log', '--format=%s'))
        .split('\n')
        .filter((subject) => subject.includes('[zapp-op:'));
      expect(markers).toHaveLength(firstKey === secondKey ? 1 : 2);
    } finally {
      releaseSecondSession();
      await rm(root, { recursive: true, force: true });
    }
  }, REAL_GIT_FIXTURE_TIMEOUT_MS);

  test('writes the constrained Builder result after adding only missing test ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-vf8-'));
    const actions: string[] = [];
    let prompt = '';
    try {
      const initialCommit = await initializeGit(root);
      const runtime = new MemoryWorkspaceRuntime(root);
      const generator = createAcceptanceSpecGenerator({
        runtime,
        session: {
          generate(input) {
            actions.push(`session:${input.role}`);
            prompt = input.prompt;
            return Promise.resolve({
              source: `// @zapp-criterion AC-3
import { expect, test } from '@playwright/test';

test('[AC-3] saves settings', async ({ page }) => {
  await page.goto('/settings');
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
});
`,
              requiredTestIds: [
                { componentPath: 'src/SaveButton.tsx', testId: 'save-button' },
                { componentPath: 'src/ConfirmDialog.tsx', testId: 'confirm-dialog' },
              ],
            });
          },
        },
        codeEdits: {
          async addTestId(input) {
            actions.push(`edit:${input.componentPath}:${input.testId}`);
            await runtime.writeFile(
              input.componentPath,
              new TextEncoder().encode(
                `export function ConfirmDialog() { return <div data-testid="${input.testId}" />; }\n`,
              ),
            );
            return input;
          },
        },
      });

      const input = {
        operationKey: 'vf8-ac3-generation-1',
        criterionId: 'AC-3',
        acceptanceCriterion: 'Saving settings shows a confirmation dialog.',
        routes,
        componentInventory: [
          { path: 'src/SaveButton.tsx', testIds: ['save-button'] },
          { path: 'src/ConfirmDialog.tsx', testIds: [] },
        ],
      } as const;
      const generated = await generator.generate(input);

      expect(generated.path).toBe('e2e/zapp/ac-3.spec.ts');
      expect(generated.commitSha).not.toBe(initialCommit);
      expect(generated.commitSha).toBe(await git(root, 'rev-parse', 'HEAD'));
      expect(await readFile(join(root, generated.path), 'utf8')).toBe(generated.source);
      expect(
        (await git(root, 'show', '--format=', '--name-only', generated.commitSha))
          .split('\n')
          .filter(Boolean)
          .sort(),
      ).toEqual(['e2e/zapp/ac-3.spec.ts', 'src/ConfirmDialog.tsx']);
      expect(actions).toEqual([
        'session:builder',
        'edit:src/ConfirmDialog.tsx:confirm-dialog',
      ]);
      expect(prompt).toContain('Return one strict JSON object');
      expect(prompt).toContain('Saving settings shows a confirmation dialog.');
      expect(prompt).toContain('src/ConfirmDialog.tsx');
      expect(prompt).toContain('/settings');

      const replay = await generator.generate(input);
      expect(replay).toEqual(generated);
      expect(actions).toEqual([
        'session:builder',
        'edit:src/ConfirmDialog.tsx:confirm-dialog',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, REAL_GIT_FIXTURE_TIMEOUT_MS);

  test('rejects nondeterministic session output before code edits or workspace writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-vf8-policy-'));
    const edits: string[] = [];
    try {
      await initializeGit(root);
      const generator = createAcceptanceSpecGenerator({
        runtime: new MemoryWorkspaceRuntime(root),
        session: {
          generate: () =>
            Promise.resolve({
              source: `// @zapp-criterion AC-4
              test('[AC-4] bad', async ({ page }) => {
                await page.getByTestId('save-button').click();
                await page.waitForTimeout(500);
              });`,
              requiredTestIds: [
                { componentPath: 'src/SaveButton.tsx', testId: 'save-button' },
              ],
            }),
        },
        codeEdits: {
          addTestId(input) {
            edits.push(input.testId);
            return Promise.resolve();
          },
        },
      });

      await expect(
        generator.generate({
          operationKey: 'vf8-ac4-generation-1',
          criterionId: 'AC-4',
          acceptanceCriterion: 'The save action completes.',
          routes,
          componentInventory: [{ path: 'src/SaveButton.tsx', testIds: [] }],
        }),
      ).rejects.toThrow('waitForTimeout');
      expect(edits).toEqual([]);
      await expect(readFile(join(root, 'e2e/zapp/ac-4.spec.ts'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, REAL_GIT_FIXTURE_TIMEOUT_MS);

  test('rejects acceptance output without its exact criterion traceability marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-vf8-traceability-'));
    try {
      await initializeGit(root);
      const generator = createAcceptanceSpecGenerator({
        runtime: new MemoryWorkspaceRuntime(root),
        session: {
          generate: () =>
            Promise.resolve({
              source: `import { test } from '@playwright/test';
test('saves settings', async ({ page }) => {
  await page.getByTestId('save-button').click();
});`,
              requiredTestIds: [
                { componentPath: 'src/SaveButton.tsx', testId: 'save-button' },
              ],
            }),
        },
        codeEdits: {
          addTestId() {
            throw new Error('unexpected test-id edit');
          },
        },
      });

      await expect(
        generator.generate({
          operationKey: 'vf8-ac5-generation-1',
          criterionId: 'AC-5',
          acceptanceCriterion: 'Settings can be saved.',
          routes,
          componentInventory: [{ path: 'src/SaveButton.tsx', testIds: ['save-button'] }],
        }),
      ).rejects.toThrow('generated_spec_criterion_marker_missing:AC-5');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, REAL_GIT_FIXTURE_TIMEOUT_MS);

  test('rejects acceptance output whose test title omits the criterion prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-vf8-title-traceability-'));
    try {
      await initializeGit(root);
      const generator = createAcceptanceSpecGenerator({
        runtime: new MemoryWorkspaceRuntime(root),
        session: {
          generate: () =>
            Promise.resolve({
              source: `// @zapp-criterion AC-9
import { test } from '@playwright/test';
test('saves settings', async ({ page }) => {
  await page.getByTestId('save-button').click();
});`,
              requiredTestIds: [
                { componentPath: 'src/SaveButton.tsx', testId: 'save-button' },
              ],
            }),
        },
        codeEdits: {
          addTestId() {
            throw new Error('unexpected test-id edit');
          },
        },
      });

      await expect(
        generator.generate({
          operationKey: 'vf8-ac9-generation-1',
          criterionId: 'AC-9',
          acceptanceCriterion: 'Settings can be saved.',
          routes,
          componentInventory: [{ path: 'src/SaveButton.tsx', testIds: ['save-button'] }],
        }),
      ).rejects.toThrow('generated_spec_criterion_title_missing:AC-9');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, REAL_GIT_FIXTURE_TIMEOUT_MS);

  test('rejects unstable selectors even when a declared test id is also present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-vf8-selectors-'));
    try {
      await initializeGit(root);
      const generator = createAcceptanceSpecGenerator({
        runtime: new MemoryWorkspaceRuntime(root),
        session: {
          generate: () =>
            Promise.resolve({
              source: `// @zapp-criterion AC-6
import { test } from '@playwright/test';
test('[AC-6] saves settings', async ({ page }) => {
  await page.getByTestId('save-button').click();
  await page.getByText('Saved').click();
});`,
              requiredTestIds: [
                { componentPath: 'src/SaveButton.tsx', testId: 'save-button' },
              ],
            }),
        },
        codeEdits: {
          addTestId() {
            throw new Error('unexpected test-id edit');
          },
        },
      });

      await expect(
        generator.generate({
          operationKey: 'vf8-ac6-generation-1',
          criterionId: 'AC-6',
          acceptanceCriterion: 'Saving settings displays confirmation.',
          routes,
          componentInventory: [{ path: 'src/SaveButton.tsx', testIds: ['save-button'] }],
        }),
      ).rejects.toThrow('generated_selector_not_stable:getByText');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, REAL_GIT_FIXTURE_TIMEOUT_MS);

  test('rejects an invalid test-id edit receipt before committing generated code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-vf8-edit-receipt-'));
    try {
      await initializeGit(root);
      const generator = createAcceptanceSpecGenerator({
        runtime: new MemoryWorkspaceRuntime(root),
        session: {
          generate: () =>
            Promise.resolve({
              source: `// @zapp-criterion AC-7
import { test } from '@playwright/test';
test('[AC-7] confirms settings', async ({ page }) => {
  await page.getByTestId('confirm-dialog').click();
});`,
              requiredTestIds: [
                { componentPath: 'src/ConfirmDialog.tsx', testId: 'confirm-dialog' },
              ],
            }),
        },
        codeEdits: {
          addTestId: () =>
            Promise.resolve({
              criterionId: 'AC-7',
              componentPath: 'src/ConfirmDialog.tsx',
              testId: 'wrong-id',
            }),
        },
      });

      await expect(
        generator.generate({
          operationKey: 'vf8-ac7-generation-1',
          criterionId: 'AC-7',
          acceptanceCriterion: 'Settings confirmation is available.',
          routes,
          componentInventory: [{ path: 'src/ConfirmDialog.tsx', testIds: [] }],
        }),
      ).rejects.toThrow('generated_test_id_edit_receipt_mismatch');
      await expect(readFile(join(root, 'e2e/zapp/ac-7.spec.ts'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, REAL_GIT_FIXTURE_TIMEOUT_MS);

  test('refuses to generate when unrelated user changes are already staged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-vf8-staged-'));
    let sessionCalls = 0;
    try {
      await initializeGit(root);
      await writeFile(join(root, 'unrelated.txt'), 'user work\n');
      await git(root, 'add', 'unrelated.txt');
      const generator = createAcceptanceSpecGenerator({
        runtime: new MemoryWorkspaceRuntime(root),
        session: {
          generate() {
            sessionCalls += 1;
            return Promise.resolve({
              source: `// @zapp-criterion AC-8
import { test } from '@playwright/test';
test('[AC-8] saves settings', async ({ page }) => {
  await page.getByTestId('save-button').click();
});`,
              requiredTestIds: [
                { componentPath: 'src/SaveButton.tsx', testId: 'save-button' },
              ],
            });
          },
        },
        codeEdits: {
          addTestId() {
            throw new Error('unexpected test-id edit');
          },
        },
      });

      await expect(
        generator.generate({
          operationKey: 'vf8-ac8-generation-1',
          criterionId: 'AC-8',
          acceptanceCriterion: 'Settings can be saved.',
          routes,
          componentInventory: [{ path: 'src/SaveButton.tsx', testIds: ['save-button'] }],
        }),
      ).rejects.toThrow('generated_spec_requires_clean_index');
      expect(sessionCalls).toBe(0);
      expect(await git(root, 'diff', '--cached', '--name-only')).toBe('unrelated.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, REAL_GIT_FIXTURE_TIMEOUT_MS);
});
