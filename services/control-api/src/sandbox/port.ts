import { CheckpointKindSchema, WorkspaceStatusSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

import { OperationKeySchema } from '../orchestrator/port.js';

export const WorkspacePortSchema = z
  .object({
    id: idSchema('ws'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    branchId: idSchema('br').nullable(),
    provider: z.string().min(1),
    providerWorkspaceId: z.string().nullable(),
    status: WorkspaceStatusSchema,
    resourceProfile: z.enum(['small', 'standard', 'large']),
    snapshotRef: z.string().nullable(),
    createdAt: z.date(),
    lastActiveAt: z.date().nullable(),
    terminatedAt: z.date().nullable(),
  })
  .strict();
export type SandboxWorkspace = z.infer<typeof WorkspacePortSchema>;

export const CreateWorkspaceInputSchema = z
  .object({
    workspace: WorkspacePortSchema,
    branchName: z.string().trim().min(1).max(255).optional(),
    operationKey: OperationKeySchema,
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.workspace.branchId === null) !== (input.branchName === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'branchName must accompany branchId',
        path: ['branchName'],
      });
    }
  });
export const CreateWorkspaceResultSchema = z
  .object({ providerWorkspaceId: z.string().min(1), status: WorkspaceStatusSchema })
  .strict();
export const StartWorkspaceInputSchema = z
  .object({ workspace: WorkspacePortSchema, operationKey: OperationKeySchema })
  .strict();
export const StartWorkspaceResultSchema = z.object({ status: WorkspaceStatusSchema }).strict();
export const CheckpointWorkspaceInputSchema = z
  .object({
    workspace: WorkspacePortSchema,
    kind: CheckpointKindSchema,
    operationKey: OperationKeySchema,
  })
  .strict();
export const CheckpointWorkspaceResultSchema = z
  .object({ snapshotRef: z.string().min(1) })
  .strict();
export const TerminateWorkspaceInputSchema = z
  .object({ workspace: WorkspacePortSchema, operationKey: OperationKeySchema })
  .strict();
export const PreviewWorkspaceInputSchema = z
  .object({
    workspace: WorkspacePortSchema,
    port: z.number().int().min(1).max(65_535),
    ttlSeconds: z.number().int().positive(),
    userId: idSchema('user'),
    operationKey: OperationKeySchema,
  })
  .strict();
export const PreviewWorkspaceResultSchema = z
  .object({ url: z.string().url(), expiresAt: z.string().datetime() })
  .strict();

const SandboxBranchLockedCauseSchema = z
  .object({ code: z.literal('branch_locked') })
  .passthrough();

export function isSandboxBranchLockedError(error: unknown): boolean {
  return SandboxBranchLockedCauseSchema.safeParse(error).success;
}

/** Public workspace lifecycle only; raw filesystem and command access stay internal. */
export interface SandboxServicePort {
  createWorkspace(
    input: z.infer<typeof CreateWorkspaceInputSchema>,
  ): Promise<unknown>;
  startWorkspace(
    input: z.infer<typeof StartWorkspaceInputSchema>,
  ): Promise<unknown>;
  checkpointWorkspace(
    input: z.infer<typeof CheckpointWorkspaceInputSchema>,
  ): Promise<unknown>;
  terminateWorkspace(input: z.infer<typeof TerminateWorkspaceInputSchema>): Promise<unknown>;
  previewWorkspace(
    input: z.infer<typeof PreviewWorkspaceInputSchema>,
  ): Promise<unknown>;
}

export class SandboxServiceError extends Error {
  constructor() {
    super('sandbox service unavailable');
    this.name = 'SandboxServiceError';
  }
}
export function createUnavailableSandboxService(): SandboxServicePort {
  const unavailable = (): Promise<never> => Promise.reject(new SandboxServiceError());
  return {
    createWorkspace: unavailable,
    startWorkspace: unavailable,
    checkpointWorkspace: unavailable,
    terminateWorkspace: unavailable,
    previewWorkspace: unavailable,
  };
}
