import type { SupportLevel } from '@zapp/contracts';
import type { ExecResult, WorkspaceRuntime } from '@zapp/workspace-runtime';
import { describe, expect, test, vi } from 'vitest';

import {
  decideVerification,
  detectActivePrototypeMocks,
  detectBroadRewrite,
  detectDisabledTests,
  detectEmptyCatches,
  detectIntroducedTodos,
  detectMissingCriticalStates,
  detectPlaceholderText,
  detectStructuralDuplicates,
  detectUnusedDependencies,
  type PolicySignal,
  type PolicySeverity,
} from '../src/index.js';

const SUPPORT_LEVELS = ['compatible', 'verified', 'managed'] as const;
const LOCATION = { path: 'src/routes/checkout.tsx', line: 12, column: 4 } as const;

const SEMGREP_OUTPUT = JSON.stringify({
  results: [
    {
      check_id: 'zapp.anti-slop.fixture',
      path: LOCATION.path,
      start: { line: LOCATION.line, col: LOCATION.column },
    },
  ],
  errors: [],
});

const KNIP_OUTPUT = JSON.stringify({
  issues: [
    {
      file: 'package.json',
      dependencies: [{ name: 'left-pad', line: 18, col: 5, pos: 240 }],
    },
  ],
});

const ESLINT_OUTPUT = JSON.stringify([
  {
    filePath: LOCATION.path,
    messages: [
      {
        ruleId: 'no-empty',
        severity: 2,
        line: LOCATION.line,
        column: LOCATION.column,
      },
    ],
  },
]);

const JSCPD_OUTPUT = `${LOCATION.path}:12-28 ~ src/components/LegacyCheckout.tsx:4-20\n---\n1 clones · 2.1% duplication\n`;

function execResult(stdout: string, exitCode = 0): ExecResult {
  return { exitCode, stdout, stderr: '', durationMs: 8, truncated: false };
}

function runtimeReturning(stdout: string, exitCode = 0): {
  runtime: WorkspaceRuntime;
  exec: ReturnType<typeof vi.fn<WorkspaceRuntime['exec']>>;
} {
  const exec = vi.fn<WorkspaceRuntime['exec']>(() => Promise.resolve(execResult(stdout, exitCode)));
  const unavailable = (): Promise<never> => Promise.reject(new Error('unused_runtime_method'));
  const runtime = {
    kind: 'cloud',
    exec,
    execStream: () => ({
      [Symbol.asyncIterator]: async function* () {
        await Promise.resolve();
      },
    }),
    readFile: unavailable,
    readFileForUpdate: unavailable,
    writeFile: unavailable,
    writeFilesAtomically: unavailable,
    search: unavailable,
    listFiles: unavailable,
    stat: unavailable,
    delete: unavailable,
    deleteFile: unavailable,
    renameFile: unavailable,
    git: unavailable,
    startDevServer: unavailable,
    restartDevServer: unavailable,
    health: unavailable,
  } satisfies WorkspaceRuntime;
  return { runtime, exec };
}

async function assertEachLevel(
  expected: Readonly<Record<SupportLevel, PolicySeverity>>,
  run: (supportLevel: SupportLevel) => PolicySignal[] | Promise<PolicySignal[]>,
  id: string,
  autofixable: boolean,
): Promise<void> {
  for (const supportLevel of SUPPORT_LEVELS) {
    const signals = await run(supportLevel);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ id, severity: expected[supportLevel], autofixable });
    expect(signals[0]?.locations.length).toBeGreaterThan(0);
    expect(typeof signals[0]?.locations[0]?.path).toBe('string');
  }
}

describe('anti-slop policy detector fixtures', () => {
  test('placeholder fixture is release-critical and blocks Verified+', async () => {
    await assertEachLevel(
      { compatible: 'warning', verified: 'blocking', managed: 'blocking' },
      async (supportLevel) => {
        const { runtime, exec } = runtimeReturning(SEMGREP_OUTPUT);
        const signals = await detectPlaceholderText({
          runtime,
          workspaceRoot: '.',
          supportLevel,
          releaseCriticalPaths: [LOCATION.path],
        });
        expect(exec.mock.calls[0]?.[0].cmd).toBe('semgrep');
        expect(exec.mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(0);
        return signals;
      },
      'placeholder',
      false,
    );
  });

  test('introduced TODO/FIXME fixture blocks only Managed', async () => {
    await assertEachLevel(
      { compatible: 'warning', verified: 'warning', managed: 'blocking' },
      async (supportLevel) => {
        const { runtime } = runtimeReturning(SEMGREP_OUTPUT);
        return detectIntroducedTodos({
          runtime,
          workspaceRoot: '.',
          supportLevel,
          requiredFeatureRanges: [
            { path: LOCATION.path, startLine: LOCATION.line, endLine: LOCATION.line },
          ],
        });
      },
      'todo',
      false,
    );
  });

  test('jscpd structural-clone fixture remains an advisory signal', async () => {
    await assertEachLevel(
      { compatible: 'warning', verified: 'warning', managed: 'warning' },
      async (supportLevel) => {
        const { runtime, exec } = runtimeReturning(JSCPD_OUTPUT);
        const signals = await detectStructuralDuplicates({
          runtime,
          workspaceRoot: '.',
          supportLevel,
        });
        expect(exec.mock.calls[0]?.[0].cmd).toBe('jscpd');
        return signals;
      },
      'duplicate',
      false,
    );
  });

  test('knip unused-dependency fixture blocks Managed', async () => {
    await assertEachLevel(
      { compatible: 'warning', verified: 'warning', managed: 'blocking' },
      async (supportLevel) => {
        const { runtime, exec } = runtimeReturning(KNIP_OUTPUT, 1);
        const signals = await detectUnusedDependencies({
          runtime,
          workspaceRoot: '.',
          supportLevel,
        });
        expect(exec.mock.calls[0]?.[0].cmd).toBe('knip');
        return signals;
      },
      'unused-deps',
      true,
    );
  });

  test('ESLint no-empty fixture blocks Verified+', async () => {
    await assertEachLevel(
      { compatible: 'warning', verified: 'blocking', managed: 'blocking' },
      async (supportLevel) => {
        const { runtime, exec } = runtimeReturning(ESLINT_OUTPUT, 1);
        const signals = await detectEmptyCatches({
          runtime,
          workspaceRoot: '.',
          supportLevel,
        });
        expect(exec.mock.calls[0]?.[0].cmd).toBe('eslint');
        return signals;
      },
      'empty-catch',
      false,
    );
  });

  test('unwaived disabled-test fixture blocks Verified+', async () => {
    await assertEachLevel(
      { compatible: 'warning', verified: 'blocking', managed: 'blocking' },
      async (supportLevel) => {
        const { runtime } = runtimeReturning(SEMGREP_OUTPUT);
        return detectDisabledTests({
          runtime,
          workspaceRoot: '.',
          supportLevel,
          introducedTestRanges: [
            { path: LOCATION.path, startLine: LOCATION.line, endLine: LOCATION.line },
          ],
          waivers: [],
        });
      },
      'disabled-tests',
      false,
    );
  });

  test('broad-rewrite fixture remains an advisory signal', async () => {
    await assertEachLevel(
      { compatible: 'warning', verified: 'warning', managed: 'warning' },
      (supportLevel) =>
        Promise.resolve(
          detectBroadRewrite({
            supportLevel,
            changedLines: 241,
            estimatedLines: 80,
            thresholdMultiplier: 3,
            locations: [LOCATION],
          }),
        ),
      'diff-size',
      false,
    );
  });

  test('active Prototype mock fixture blocks only Managed', async () => {
    await assertEachLevel(
      { compatible: 'warning', verified: 'warning', managed: 'blocking' },
      (supportLevel) =>
        Promise.resolve(
          detectActivePrototypeMocks({
            supportLevel,
            activeMocks: [{ name: 'billing-provider', locations: [LOCATION] }],
          }),
        ),
      'mock-detect',
      false,
    );
  });

  test('precomputed missing-state fixture stays Minor/advisory at every level', async () => {
    await assertEachLevel(
      { compatible: 'warning', verified: 'warning', managed: 'warning' },
      (supportLevel) =>
        Promise.resolve(
          detectMissingCriticalStates({
            supportLevel,
            findings: [{ missing: ['loading', 'error'], location: LOCATION }],
          }),
        ),
      'states-check',
      false,
    );
  });

  test('blocking policy signals reject while advisory signals remain non-blocking', () => {
    const criterion = {
      criterionId: 'AC-1',
      specificationVersion: 1,
      taskIds: ['task_01J00000000000000000000000'],
      testCaseIds: ['tcase_01'],
      result: 'passed' as const,
      evidenceArtifactIds: ['art_01'],
      verifierComments: [],
    };
    const policySignal = {
      id: 'placeholder' as const,
      severity: 'blocking' as const,
      locations: [LOCATION],
      autofixable: false,
    };

    expect(
      decideVerification({
        gateEvaluations: [],
        criteria: [criterion],
        criticalCriterionIds: [],
        policySignals: [policySignal],
      }),
    ).toMatchObject({
      decision: 'rejected',
      risks: [{ code: 'policy_signal', severity: 'blocking', policySignal }],
    });
    expect(
      decideVerification({
        gateEvaluations: [],
        criteria: [criterion],
        criticalCriterionIds: [],
        policySignals: [{ ...policySignal, severity: 'warning' }],
      }).decision,
    ).toBe('approved');
  });
});
