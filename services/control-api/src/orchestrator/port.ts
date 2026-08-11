import {
  OperationKeySchema,
  SignalRunInputSchema,
  SignalRunResultSchema,
  StartRunInputSchema,
  type SignalRunInput,
  type StartRunInput,
} from '@zapp/contracts';

export {
  OperationKeySchema,
  SignalRunInputSchema,
  SignalRunResultSchema,
  StartRunInputSchema,
  type SignalRunInput,
  type StartRunInput,
};

/** The durable-workflow boundary for the public run lifecycle. */
export interface OrchestratorPort {
  /** Starts exactly one workflow for a durably recorded run intent. */
  startRun(input: StartRunInput): Promise<unknown>;
  /** An operation key makes retried signals equivalent at the durable workflow. */
  signalRun(input: SignalRunInput): Promise<unknown>;
}

/** A port failure whose text is safe to turn into a generic public failure. */
export class OrchestratorError extends Error {
  constructor(message = 'the orchestrator is unavailable') {
    super(message);
    this.name = 'OrchestratorError';
  }
}

/** A reconciled start failure where Temporal proves that no stable execution exists. */
export class DispatchNotStartedError extends OrchestratorError {
  public readonly code = 'dispatch_not_started' as const;

  constructor() {
    super('the workflow dispatch was not started');
    this.name = 'DispatchNotStartedError';
  }
}

/** A deployment without the Temporal binding must fail closed. */
export function createUnavailableOrchestrator(): OrchestratorPort {
  const unavailable = (): Promise<never> => Promise.reject(new OrchestratorError());
  return { startRun: unavailable, signalRun: unavailable };
}
