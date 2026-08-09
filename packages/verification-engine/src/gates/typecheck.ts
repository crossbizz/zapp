import type { Gate } from './registry.js';
import { DEFAULT_GATE_TIMEOUT_MS, executeGateCommand, notApplicable } from './shared.js';

export function createTypecheckGate(): Gate {
  return {
    id: 'typecheck',
    async run(ctx) {
      const command = ctx.contract.typecheck?.command;
      if (command === undefined) return notApplicable('typecheck_command_absent');
      return executeGateCommand(ctx, {
        artifactKind: 'verification.typecheck',
        command,
        timeoutMs: DEFAULT_GATE_TIMEOUT_MS,
        summarize: (result) => ({
          exitCode: result.exitCode,
          errorCount: [...`${result.stdout}\n${result.stderr}`.matchAll(/\berror TS\d+:/gu)].length,
          truncated: result.truncated,
        }),
      });
    },
  };
}
