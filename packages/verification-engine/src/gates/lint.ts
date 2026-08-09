import { z } from 'zod';

import type { Gate } from './registry.js';
import { DEFAULT_GATE_TIMEOUT_MS, executeGateCommand, notApplicable } from './shared.js';

const EslintResultSchema = z.array(
  z.object({ errorCount: z.number().int().nonnegative(), warningCount: z.number().int().nonnegative() }).passthrough(),
);

function eslintSummary(stdout: string): { errorCount: number; warningCount: number } {
  try {
    const parsed = EslintResultSchema.parse(JSON.parse(stdout) as unknown);
    return parsed.reduce(
      (total, result) => ({
        errorCount: total.errorCount + result.errorCount,
        warningCount: total.warningCount + result.warningCount,
      }),
      { errorCount: 0, warningCount: 0 },
    );
  } catch {
    return { errorCount: 0, warningCount: 0 };
  }
}

export function createLintGate(): Gate {
  return {
    id: 'lint',
    async run(ctx) {
      const command = ctx.contract.lint?.command;
      if (command === undefined) return notApplicable('lint_command_absent');
      return executeGateCommand(ctx, {
        artifactKind: 'verification.lint',
        command,
        timeoutMs: DEFAULT_GATE_TIMEOUT_MS,
        summarize: (result) => ({ exitCode: result.exitCode, ...eslintSummary(result.stdout) }),
      });
    },
  };
}
