import type { Gate } from './registry.js';
import { executeGateCommand, notApplicable } from './shared.js';

export function createBuildGate(): Gate {
  return {
    id: 'production_build',
    async run(ctx) {
      const command = ctx.contract.build;
      if (command === undefined) return notApplicable('build_command_absent');
      return executeGateCommand(ctx, {
        artifactKind: 'verification.production_build',
        command: command.command,
        timeoutMs: (command.timeout_seconds ?? 300) * 1_000,
        summarize: (result) => ({
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          truncated: result.truncated,
        }),
      });
    },
  };
}
