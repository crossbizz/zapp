import {
  AppTypeSchema,
  idSchema,
  ModelIdentifierSchema,
  RunModeSchema,
} from '@zapp/contracts';
import { z } from 'zod';

export const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/);

export const StartRunInputSchema = z
  .object({
    runId: idSchema('run'),
    workflowId: z.string().min(1).max(255),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    branchId: idSchema('br').nullable(),
    mode: RunModeSchema,
    appType: AppTypeSchema,
    model: ModelIdentifierSchema.nullable(),
    prompt: z.string().min(1).max(20_000),
    budget: z
      .object({ maxCredits: z.number().int().positive().max(1_000_000) })
      .strict()
      .nullable(),
    operationKey: OperationKeySchema,
  })
  .strict();
export type StartRunInput = z.infer<typeof StartRunInputSchema>;

export const SignalRunInputSchema = z
  .object({
    runId: idSchema('run'),
    workflowId: z.string().min(1).max(255),
    signal: z.enum(['pause', 'resume', 'cancel', 'redirect']),
    prompt: z.string().min(1).max(20_000).optional(),
    operationKey: OperationKeySchema,
  })
  .strict();
export type SignalRunInput = z.infer<typeof SignalRunInputSchema>;

export const SignalRunResultSchema = z.object({ applied: z.boolean() }).strict();

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

/** A deployment without the Temporal binding must fail closed. */
export function createUnavailableOrchestrator(): OrchestratorPort {
  const unavailable = (): Promise<never> => Promise.reject(new OrchestratorError());
  return { startRun: unavailable, signalRun: unavailable };
}
