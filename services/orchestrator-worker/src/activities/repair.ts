import {
  RepairLoopInputSchema,
  RepairLoopResultSchema,
  runRepairLoop,
  type RepairBuilderPort,
  type RepairCheckPort,
  type RepairCommitPort,
  type RepairLoopDependencies,
  type RepairLoopInput,
  type RepairLoopResult,
  type RepairOutcomePort,
  type RepairTaskPort,
} from '@zapp/verification-engine';

import {
  redactRepairFailure,
  repairBuilderContextFromFailure,
} from '../session/context.js';

export interface RepairActivities {
  repairTask(input: RepairLoopInput): Promise<RepairLoopResult>;
}

export interface RepairActivityDependencies {
  readonly redact: (value: string) => string;
  readonly modelClassifier: RepairLoopDependencies['modelClassifier'];
  readonly repairTasks: RepairTaskPort;
  readonly builder: RepairBuilderPort;
  readonly commits: RepairCommitPort;
  readonly checks: RepairCheckPort;
  readonly outcomes: RepairOutcomePort;
}

export function createRepairActivities(
  dependencies: RepairActivityDependencies,
): RepairActivities {
  return {
    async repairTask(inputValue) {
      const input = RepairLoopInputSchema.parse(inputValue);
      const failure = redactRepairFailure(input.failure, dependencies.redact);
      const builderContext = repairBuilderContextFromFailure(failure);
      return RepairLoopResultSchema.parse(
        await runRepairLoop(
          { ...input, failure, builderContext },
          {
            modelClassifier: {
              async classify(request, scope) {
                const response = await dependencies.modelClassifier.classify(request, scope);
                if (
                  typeof response === 'object' &&
                  response !== null &&
                  !Array.isArray(response) &&
                  'reason' in response &&
                  typeof response.reason === 'string'
                ) {
                  return { ...response, reason: dependencies.redact(response.reason) };
                }
                return response;
              },
            },
            repairTasks: dependencies.repairTasks,
            builder: dependencies.builder,
            commits: dependencies.commits,
            checks: dependencies.checks,
            outcomes: dependencies.outcomes,
          },
        ),
      );
    },
  };
}
