import {
  BuilderPreviewLogsQuerySchema,
  CheckpointKindSchema,
  ExecutionContractSchema,
  WorkspaceStatusSchema,
  idSchema,
} from '@zapp/contracts';
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
    runId: idSchema('run').nullable(),
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
export const SupportTerminateWorkspaceResultSchema = z
  .object({ status: z.literal('terminated'), terminatedAt: z.date() })
  .strict();
export const TerminateOrganizationInputSchema = z
  .object({
    organizationId: idSchema('org'),
    actorUserId: idSchema('user'),
    reason: z.string().trim().min(10).max(500),
    operationKey: OperationKeySchema,
  })
  .strict();
export const TerminateOrganizationResultSchema = z
  .object({ terminated: z.number().int().nonnegative() })
  .strict();

const SandboxBranchLockedCauseSchema = z.object({ code: z.literal('branch_locked') }).passthrough();

export function isSandboxBranchLockedError(error: unknown): boolean {
  return SandboxBranchLockedCauseSchema.safeParse(error).success;
}

/** Public workspace lifecycle only; raw filesystem and command access stay internal. */
export interface SandboxServicePort {
  createWorkspace(input: z.infer<typeof CreateWorkspaceInputSchema>): Promise<unknown>;
  startWorkspace(input: z.infer<typeof StartWorkspaceInputSchema>): Promise<unknown>;
  checkpointWorkspace(input: z.infer<typeof CheckpointWorkspaceInputSchema>): Promise<unknown>;
  terminateWorkspace(input: z.infer<typeof TerminateWorkspaceInputSchema>): Promise<unknown>;
}

/** OPS-17's service-authenticated WS-15 bridge; never exposed to ordinary tenant routes. */
export interface SupportSandboxServicePort {
  terminateWorkspace(
    input: z.infer<typeof TerminateWorkspaceInputSchema>,
  ): Promise<z.infer<typeof SupportTerminateWorkspaceResultSchema>>;
  terminateOrganization(
    input: z.infer<typeof TerminateOrganizationInputSchema>,
  ): Promise<z.infer<typeof TerminateOrganizationResultSchema>>;
}

export const ReadBuilderPreviewLogsInputSchema = z
  .object({
    workspace: WorkspacePortSchema,
    after: BuilderPreviewLogsQuerySchema.shape.after,
    limit: BuilderPreviewLogsQuerySchema.shape.limit,
  })
  .strict();

export const RestartBuilderPreviewInputSchema = z
  .object({
    workspace: WorkspacePortSchema,
    contract: ExecutionContractSchema,
    operationKey: OperationKeySchema,
  })
  .strict();

/** Narrow bridge used only by the authenticated public builder-preview routes. */
export interface BuilderPreviewSandboxPort {
  readDevServerLogs(input: z.infer<typeof ReadBuilderPreviewLogsInputSchema>): Promise<unknown>;
  restartDevServer(input: z.infer<typeof RestartBuilderPreviewInputSchema>): Promise<unknown>;
}

export class SandboxServiceError extends Error {
  constructor(options?: ErrorOptions) {
    super('sandbox service unavailable', options);
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
  };
}

export function createUnavailableSupportSandboxService(): SupportSandboxServicePort {
  const unavailable = (): Promise<never> => Promise.reject(new SandboxServiceError());
  return { terminateWorkspace: unavailable, terminateOrganization: unavailable };
}

export function createUnavailableBuilderPreviewSandbox(): BuilderPreviewSandboxPort {
  const unavailable = (): Promise<never> => Promise.reject(new SandboxServiceError());
  return { readDevServerLogs: unavailable, restartDevServer: unavailable };
}
