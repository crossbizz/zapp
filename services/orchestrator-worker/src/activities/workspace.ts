import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

const IdempotencyKeySchema = z.string().min(1).max(512);

export const EnsureWorkspaceInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    branchId: idSchema('br').nullable(),
    appType: z.enum(['web', 'mobile']),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export type EnsureWorkspaceInput = z.infer<typeof EnsureWorkspaceInputSchema>;

export const EnsureWorkspaceResultSchema = z
  .object({ workspaceId: z.string().min(1).max(512) })
  .strict();
export type EnsureWorkspaceResult = z.infer<typeof EnsureWorkspaceResultSchema>;

export const CommitAndPushInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    workspaceId: z.string().min(1).max(512),
    message: z.string().min(1).max(10_000),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export type CommitAndPushInput = z.infer<typeof CommitAndPushInputSchema>;

export const CommitDiffstatEntrySchema = z
  .object({
    path: z.string().min(1).max(4_096),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict();

export const CommitAndPushResultSchema = z
  .object({
    commitSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
    diffstat: z.array(CommitDiffstatEntrySchema).max(10_000),
  })
  .strict();
export type CommitAndPushResult = z.infer<typeof CommitAndPushResultSchema>;

export interface WorkspaceActivityPort {
  ensureWorkspace(input: EnsureWorkspaceInput): Promise<EnsureWorkspaceResult>;
  commitAndPush(input: CommitAndPushInput): Promise<CommitAndPushResult>;
}

export interface WorkspaceActivities {
  ensureWorkspace(input: EnsureWorkspaceInput): Promise<EnsureWorkspaceResult>;
  commitAndPush(input: CommitAndPushInput): Promise<CommitAndPushResult>;
}

export function createWorkspaceActivities(port: WorkspaceActivityPort): WorkspaceActivities {
  return {
    async ensureWorkspace(inputValue) {
      const input = EnsureWorkspaceInputSchema.parse(inputValue);
      return EnsureWorkspaceResultSchema.parse(await port.ensureWorkspace(input));
    },
    async commitAndPush(inputValue) {
      const input = CommitAndPushInputSchema.parse(inputValue);
      return CommitAndPushResultSchema.parse(await port.commitAndPush(input));
    },
  };
}
