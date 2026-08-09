import type { ExecutionContract } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { z } from 'zod';

import { GateIdSchema, type GateId } from '../policy-matrix.js';

export const GateResultSchema = z
  .object({
    status: z.enum(['passed', 'failed', 'waived', 'not_applicable']),
    evidenceArtifactIds: z.array(z.string().min(1)),
    details: z.record(z.unknown()),
  })
  .strict();
export type GateResult = z.infer<typeof GateResultSchema>;

export interface EvidenceArtifactSink {
  store(input: { readonly kind: string; readonly body: Uint8Array }): Promise<string>;
}

export interface GateContext {
  readonly runtime: WorkspaceRuntime;
  readonly contract: ExecutionContract;
  readonly commit: string;
  readonly criteria: readonly string[];
  readonly artifacts: EvidenceArtifactSink;
}

export interface Gate {
  readonly id: GateId;
  run(ctx: GateContext): Promise<GateResult>;
}

export class GateRegistry {
  readonly #gates = new Map<GateId, Gate>();

  register(gate: Gate): void {
    const id = GateIdSchema.parse(gate.id);
    if (this.#gates.has(id)) throw new Error('gate_already_registered');
    this.#gates.set(id, gate);
  }

  get(idValue: unknown): Gate | undefined {
    return this.#gates.get(GateIdSchema.parse(idValue));
  }

  ids(): GateId[] {
    return [...this.#gates.keys()];
  }
}
