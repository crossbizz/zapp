import {
  WorkspacePurposeSchema,
  idSchema,
  type WorkspacePurpose,
} from '@zapp/contracts';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const MINUTE_MS = 60_000;
const INTERACTIVE_IDLE_MS = 15 * MINUTE_MS;
const AUTONOMOUS_IDLE_MS = 30 * MINUTE_MS;

export const HARD_REPLACE_MS = 23 * 60 * MINUTE_MS;
const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);

export function idleTimeoutMs(input: unknown): number {
  const purpose = WorkspacePurposeSchema.parse(input);
  const deadlines = {
    builder: INTERACTIVE_IDLE_MS,
    preview: INTERACTIVE_IDLE_MS,
    verifier: AUTONOMOUS_IDLE_MS,
    scan: AUTONOMOUS_IDLE_MS,
  } as const satisfies Record<WorkspacePurpose, number>;
  return deadlines[purpose];
}

const ReaperCandidateSchema = z
  .object({
    workspaceId: idSchema('ws'),
    purpose: WorkspacePurposeSchema,
    status: z.enum(['active', 'checkpointing', 'idle']),
    createdAt: z.date(),
    lastActiveAt: z.date().nullable(),
    operationKey: OperationKeySchema,
  })
  .strict();

const ReaperSummarySchema = z
  .object({
    reaped: z.number().int().nonnegative(),
    idle: z.number().int().nonnegative(),
    hardReplaced: z.number().int().nonnegative(),
  })
  .strict();

export type ReaperSummary = z.infer<typeof ReaperSummarySchema>;

const ReaperActionInputSchema = z
  .object({ workspaceId: idSchema('ws'), operationKey: OperationKeySchema })
  .strict();
const ReaperClaimInputSchema = ReaperActionInputSchema.extend({
  expectedStatus: z.literal('active'),
  expectedLastActiveAt: z.date().nullable(),
}).strict();
const ReaperTransitionInputSchema = ReaperActionInputSchema.extend({
  from: z.enum(['checkpointing', 'idle']),
  to: z.enum(['idle', 'terminated']),
}).strict();

type ReaperActionInput = z.infer<typeof ReaperActionInputSchema>;
type ReaperClaimInput = z.infer<typeof ReaperClaimInputSchema>;
type ReaperTransitionInput = z.infer<typeof ReaperTransitionInputSchema>;

export interface WorkspaceReaperDependencies {
  now(): Date;
  /** Atomically asserts status/activity and changes active -> checkpointing. */
  claim(input: ReaperClaimInput): Promise<boolean>;
  checkpoint(input: ReaperActionInput): Promise<void>;
  terminate(input: ReaperActionInput): Promise<void>;
  transition(input: ReaperTransitionInput): Promise<void>;
}

function childOperationKey(parent: string, action: string): string {
  return `op_${createHash('sha256').update(`${parent}:${action}`).digest('hex')}`;
}

export function createWorkspaceReaper(dependencies: WorkspaceReaperDependencies): {
  sweep(candidates: unknown): Promise<ReaperSummary>;
} {
  return {
    async sweep(candidatesInput) {
      const candidates = z.array(ReaperCandidateSchema).parse(candidatesInput);
      const now = z.date().parse(dependencies.now()).getTime();
      let idle = 0;
      let hardReplaced = 0;

      for (const candidate of candidates) {
        const hardReplacementDue = now - candidate.createdAt.getTime() >= HARD_REPLACE_MS;
        const activityAnchor = candidate.lastActiveAt ?? candidate.createdAt;
        const idleDue = now - activityAnchor.getTime() >= idleTimeoutMs(candidate.purpose);
        if (candidate.status === 'active' && !hardReplacementDue && !idleDue) {
          continue;
        }

        let status: 'checkpointing' | 'idle';
        if (candidate.status === 'active') {
          const claimed = await dependencies.claim(
            ReaperClaimInputSchema.parse({
              workspaceId: candidate.workspaceId,
              operationKey: childOperationKey(candidate.operationKey, 'claim'),
              expectedStatus: 'active',
              expectedLastActiveAt: candidate.lastActiveAt,
            }),
          );
          if (!claimed) continue;
          status = 'checkpointing';
        } else {
          status = candidate.status;
        }

        if (status === 'checkpointing') {
          await dependencies.checkpoint(
            ReaperActionInputSchema.parse({
              workspaceId: candidate.workspaceId,
              operationKey: childOperationKey(candidate.operationKey, 'checkpoint'),
            }),
          );
          await dependencies.transition(
            ReaperTransitionInputSchema.parse({
              workspaceId: candidate.workspaceId,
              operationKey: childOperationKey(candidate.operationKey, 'mark-idle'),
              from: 'checkpointing',
              to: 'idle',
            }),
          );
        }

        await dependencies.terminate(
          ReaperActionInputSchema.parse({
            workspaceId: candidate.workspaceId,
            operationKey: childOperationKey(candidate.operationKey, 'terminate'),
          }),
        );
        await dependencies.transition(
          ReaperTransitionInputSchema.parse({
            workspaceId: candidate.workspaceId,
            operationKey: childOperationKey(candidate.operationKey, 'mark-terminated'),
            from: 'idle',
            to: 'terminated',
          }),
        );

        if (hardReplacementDue) {
          hardReplaced += 1;
        } else {
          idle += 1;
        }
      }

      return ReaperSummarySchema.parse({
        reaped: idle + hardReplaced,
        idle,
        hardReplaced,
      });
    },
  };
}
