import { z } from 'zod';

import type { Gate } from './registry.js';
import { DEFAULT_GATE_TIMEOUT_MS, executeGateCommand, notApplicable } from './shared.js';

const JestSummarySchema = z
  .object({
    numTotalTests: z.number().int().nonnegative(),
    numPassedTests: z.number().int().nonnegative(),
    numFailedTests: z.number().int().nonnegative(),
  })
  .passthrough();

function testSummary(stdout: string): { total: number; passed: number; failed: number } {
  try {
    const parsed = JestSummarySchema.parse(JSON.parse(stdout) as unknown);
    return {
      total: parsed.numTotalTests,
      passed: parsed.numPassedTests,
      failed: parsed.numFailedTests,
    };
  } catch {
    return { total: 0, passed: 0, failed: 0 };
  }
}

export function createUnitTestsGate(): Gate {
  return {
    id: 'unit_tests',
    async run(ctx) {
      const command = ctx.contract.test?.unit;
      if (command === undefined) return notApplicable('unit_test_command_absent');
      return executeGateCommand(ctx, {
        artifactKind: 'verification.unit_tests',
        command,
        timeoutMs: DEFAULT_GATE_TIMEOUT_MS,
        summarize: (result) => ({ exitCode: result.exitCode, ...testSummary(result.stdout) }),
      });
    },
  };
}
