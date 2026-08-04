import type { RunMode } from '@zapp/contracts';
import type { AgentRun } from '@zapp/db';

/** The durable-workflow boundary for the public run lifecycle. */
export interface OrchestratorPort {
  /** Starts exactly one workflow for a persisted run. */
  startRun(input: {
    readonly runId: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly branchId: string | null;
    readonly mode: RunMode;
    readonly prompt: string;
    readonly budget: unknown;
    /** The run id is the Temporal workflow idempotency key. */
    readonly idempotencyKey: string;
  }): Promise<void>;
  /** False means the durable workflow cannot accept this signal in its current state. */
  signalRun(input: {
    readonly run: AgentRun;
    readonly signal: 'pause' | 'resume' | 'cancel' | 'redirect';
    readonly prompt?: string;
  }): Promise<boolean>;
}

/** A port failure whose text is safe to turn into a generic public failure. */
export class OrchestratorError extends Error {
  constructor(message = 'the orchestrator is unavailable') {
    super(message);
    this.name = 'OrchestratorError';
  }
}

/**
 * A deployment without the Temporal binding must fail the mutation instead of
 * returning a queued run whose workflow was never started.
 */
export function createUnavailableOrchestrator(): OrchestratorPort {
  const unavailable = (): Promise<never> => Promise.reject(new OrchestratorError());
  return { startRun: unavailable, signalRun: unavailable };
}
