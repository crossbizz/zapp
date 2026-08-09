import {
  WorkspaceStatusSchema,
  idSchema,
  type WorkspaceStatus,
} from '@zapp/contracts';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const WorkspaceIdSchema = idSchema('ws');
const OrganizationIdSchema = idSchema('org');
const ProjectIdSchema = idSchema('proj');
const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);

const LifecycleScopeSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    organizationId: OrganizationIdSchema,
    projectId: ProjectIdSchema,
    operationKey: OperationKeySchema,
  })
  .strict();

export type LifecycleScope = z.infer<typeof LifecycleScopeSchema>;

const NEXT_STATUS = {
  requested: 'provisioning',
  provisioning: 'started',
  started: 'ready',
  ready: 'active',
  active: 'checkpointing',
  checkpointing: 'idle',
  idle: 'terminated',
  terminated: undefined,
} as const satisfies Record<WorkspaceStatus, WorkspaceStatus | undefined>;

export class InvalidTransition extends Error {
  public constructor(from: WorkspaceStatus, to: WorkspaceStatus) {
    super(`Invalid workspace lifecycle transition: ${from} -> ${to}`);
    this.name = 'InvalidTransition';
  }
}

export function transitionLifecycle(fromInput: unknown, toInput: unknown): WorkspaceStatus {
  const from = WorkspaceStatusSchema.parse(fromInput);
  const to = WorkspaceStatusSchema.parse(toInput);
  if (NEXT_STATUS[from] !== to) {
    throw new InvalidTransition(from, to);
  }
  return to;
}

const LifecycleFailureKindSchema = z.enum([
  'provider_creation_failure',
  'scheduling_delay',
  'readiness_failure',
  'oom',
  'command_timeout',
  'network_failure',
  'unexpected_termination',
  'expired_sandbox_id',
  'expired_snapshot',
  'volume_sync_failure',
]);

const LifecycleFailureDispositionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retry_creation'), maxAttempts: z.literal(3) }).strict(),
  z.object({ action: z.literal('retry_status') }).strict(),
  z
    .object({ action: z.literal('capture_boot_logs_then_terminate'), abnormal: z.literal(true) })
    .strict(),
  z
    .object({ action: z.literal('terminate_then_restore_checkpoint'), abnormal: z.literal(true) })
    .strict(),
  z.object({ action: z.literal('fail_command') }).strict(),
  z.object({ action: z.literal('retry_network_operation') }).strict(),
  z.object({ action: z.literal('restore_workspace') }).strict(),
  z.object({ action: z.literal('restore_from_git_and_artifacts') }).strict(),
]);

export type LifecycleFailureDisposition = z.infer<typeof LifecycleFailureDispositionSchema>;

export function lifecycleFailureDisposition(input: unknown): LifecycleFailureDisposition {
  const kind = LifecycleFailureKindSchema.parse(input);
  const disposition = (() => {
    switch (kind) {
      case 'provider_creation_failure':
        return { action: 'retry_creation', maxAttempts: 3 } as const;
      case 'scheduling_delay':
        return { action: 'retry_status' } as const;
      case 'readiness_failure':
        return { action: 'capture_boot_logs_then_terminate', abnormal: true } as const;
      case 'oom':
      case 'unexpected_termination':
        return { action: 'terminate_then_restore_checkpoint', abnormal: true } as const;
      case 'command_timeout':
        return { action: 'fail_command' } as const;
      case 'network_failure':
        return { action: 'retry_network_operation' } as const;
      case 'expired_sandbox_id':
        return { action: 'restore_workspace' } as const;
      case 'expired_snapshot':
      case 'volume_sync_failure':
        return { action: 'restore_from_git_and_artifacts' } as const;
    }
  })();
  return LifecycleFailureDispositionSchema.parse(disposition);
}

const LifecycleFailureInputSchema = LifecycleScopeSchema.extend({
  kind: LifecycleFailureKindSchema,
}).strict();

export interface LifecycleFailureDependencies {
  retryCreation(scope: LifecycleScope, maxAttempts: 3): Promise<void>;
  retryStatus(scope: LifecycleScope): Promise<void>;
  captureBootLogsArtifact(scope: LifecycleScope): Promise<void>;
  markTerminated(scope: LifecycleScope, abnormal: true): Promise<void>;
  recoverFromCheckpoint(scope: LifecycleScope): Promise<void>;
  failCommand(scope: LifecycleScope): Promise<void>;
  retryNetworkOperation(scope: LifecycleScope): Promise<void>;
  restoreWorkspace(scope: LifecycleScope): Promise<void>;
  restoreFromGitAndArtifacts(scope: LifecycleScope): Promise<void>;
}

export async function handleLifecycleFailure(
  input: unknown,
  dependencies: LifecycleFailureDependencies,
): Promise<LifecycleFailureDisposition> {
  const parsed = LifecycleFailureInputSchema.parse(input);
  const { kind, ...untrustedScope } = parsed;
  const scope = LifecycleScopeSchema.parse(untrustedScope);
  const disposition = lifecycleFailureDisposition(kind);

  switch (kind) {
    case 'provider_creation_failure':
      await dependencies.retryCreation(scope, 3);
      break;
    case 'scheduling_delay':
      await dependencies.retryStatus(scope);
      break;
    case 'readiness_failure':
      await dependencies.captureBootLogsArtifact(scope);
      await dependencies.markTerminated(scope, true);
      break;
    case 'oom':
    case 'unexpected_termination':
      await dependencies.markTerminated(scope, true);
      await dependencies.recoverFromCheckpoint(scope);
      break;
    case 'command_timeout':
      await dependencies.failCommand(scope);
      break;
    case 'network_failure':
      await dependencies.retryNetworkOperation(scope);
      break;
    case 'expired_sandbox_id':
      await dependencies.restoreWorkspace(scope);
      break;
    case 'expired_snapshot':
    case 'volume_sync_failure':
      await dependencies.restoreFromGitAndArtifacts(scope);
      break;
  }

  return disposition;
}

const CreationNoticeSchema = z
  .object({
    kind: z.literal('creation_failed'),
    ...LifecycleScopeSchema.shape,
    attempts: z.literal(3),
    abnormal: z.literal(true),
  })
  .strict();

const ProvisionSuccessSchema = z
  .object({ providerWorkspaceId: z.string().min(1) })
  .strict();

const ProvisionResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('started'),
      attempts: z.number().int().min(1).max(3),
      workspaceStatus: z.literal('started'),
      providerWorkspaceId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('failed'),
      attempts: z.literal(3),
      workspaceStatus: z.literal('terminated'),
    })
    .strict(),
]);

export type CreationNotice = z.infer<typeof CreationNoticeSchema>;
export type ProvisionResult = z.infer<typeof ProvisionResultSchema>;

export interface LifecycleManagerDependencies {
  sleep(milliseconds: number): Promise<void>;
  jitterDelayMs(attempt: number): number;
  emit(notice: CreationNotice): Promise<void>;
  forceTerminal(scope: LifecycleScope, abnormal: true): Promise<void>;
}

export function createLifecycleManager(dependencies: LifecycleManagerDependencies): {
  provision(
    scope: unknown,
    create: (attempt: { attempt: number; operationKey: string }) => Promise<unknown>,
  ): Promise<ProvisionResult>;
} {
  return {
    async provision(scopeInput, create) {
      const scope = LifecycleScopeSchema.parse(scopeInput);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        let untrustedCreated: unknown;
        try {
          untrustedCreated = await create({ attempt, operationKey: scope.operationKey });
        } catch {
          untrustedCreated = undefined;
        }
        const created = ProvisionSuccessSchema.safeParse(untrustedCreated);
        if (created.success) {
          return ProvisionResultSchema.parse({
            outcome: 'started',
            attempts: attempt,
            workspaceStatus: 'started',
            providerWorkspaceId: created.data.providerWorkspaceId,
          });
        }
        if (attempt === 3) {
          await dependencies.forceTerminal(scope, true);
          await dependencies.emit(
            CreationNoticeSchema.parse({
              kind: 'creation_failed',
              ...scope,
              attempts: 3,
              abnormal: true,
            }),
          );
          return ProvisionResultSchema.parse({
            outcome: 'failed',
            attempts: 3,
            workspaceStatus: 'terminated',
          });
        }
        const delay = z.number().int().nonnegative().parse(dependencies.jitterDelayMs(attempt));
        await dependencies.sleep(delay);
      }
      throw new Error('Unreachable workspace provisioning state');
    },
  };
}

const ReconciliationRowSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    organizationId: OrganizationIdSchema,
    projectId: ProjectIdSchema,
    providerWorkspaceId: z.string().min(1),
    status: WorkspaceStatusSchema,
  })
  .strict();

const ProviderSandboxSchema = z
  .object({
    providerWorkspaceId: z.string().min(1),
    organizationId: OrganizationIdSchema,
    projectId: ProjectIdSchema,
  })
  .strict();

const ReconciliationInputSchema = z
  .object({
    operationKey: OperationKeySchema,
    rows: z.array(ReconciliationRowSchema),
    providerSandboxes: z.array(ProviderSandboxSchema),
  })
  .strict();

const ReconciliationAlertSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('orphan_provider'),
      providerWorkspaceId: z.string().min(1),
      organizationId: OrganizationIdSchema,
      projectId: ProjectIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('stale_database_row'),
      workspaceId: WorkspaceIdSchema,
      organizationId: OrganizationIdSchema,
      projectId: ProjectIdSchema,
    })
    .strict(),
]);

export type ReconciliationAlert = z.infer<typeof ReconciliationAlertSchema>;

const ReconciliationMutationScopeSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    projectId: ProjectIdSchema,
    operationKey: OperationKeySchema,
    leaseToken: z.string().min(1),
  })
  .strict();

const TerminateProviderInputSchema = ReconciliationMutationScopeSchema.extend({
  providerWorkspaceId: z.string().min(1),
}).strict();
const MarkTerminatedInputSchema = ReconciliationMutationScopeSchema.extend({
  workspaceId: WorkspaceIdSchema,
}).strict();

type TerminateProviderInput = z.infer<typeof TerminateProviderInputSchema>;
type MarkTerminatedInput = z.infer<typeof MarkTerminatedInputSchema>;

export interface ReconciliationDependencies {
  acquireLeaderLease(operationKey: string): Promise<string | undefined>;
  releaseLeaderLease(leaseToken: string): Promise<void>;
  terminateProvider(input: TerminateProviderInput): Promise<void>;
  markTerminated(input: MarkTerminatedInput, abnormal: true): Promise<void>;
  alert(alert: ReconciliationAlert, operationKey: string, leaseToken: string): Promise<void>;
}

function childOperationKey(parent: string, action: string, target: string): string {
  return `op_${createHash('sha256').update(`${parent}:${action}:${target}`).digest('hex')}`;
}

function sameProviderIdentity(
  left: z.infer<typeof ReconciliationRowSchema>,
  right: z.infer<typeof ProviderSandboxSchema>,
): boolean {
  return (
    left.providerWorkspaceId === right.providerWorkspaceId &&
    left.organizationId === right.organizationId &&
    left.projectId === right.projectId
  );
}

export async function reconcileWorkspaces(
  input: unknown,
  dependencies: ReconciliationDependencies,
): Promise<{
  leaseAcquired: boolean;
  orphanProvidersTerminated: number;
  staleRowsTerminated: number;
}> {
  const parsed = ReconciliationInputSchema.parse(input);
  const leaseToken = await dependencies.acquireLeaderLease(parsed.operationKey);
  if (leaseToken === undefined) {
    return { leaseAcquired: false, orphanProvidersTerminated: 0, staleRowsTerminated: 0 };
  }
  let orphanProvidersTerminated = 0;
  let staleRowsTerminated = 0;

  try {
    for (const sandbox of parsed.providerSandboxes) {
      if (!parsed.rows.some((row) => sameProviderIdentity(row, sandbox))) {
        await dependencies.terminateProvider(
          TerminateProviderInputSchema.parse({
            ...sandbox,
            operationKey: childOperationKey(
              parsed.operationKey,
              'terminate-orphan',
              sandbox.providerWorkspaceId,
            ),
            leaseToken,
          }),
        );
        await dependencies.alert(
          ReconciliationAlertSchema.parse({ kind: 'orphan_provider', ...sandbox }),
          childOperationKey(parsed.operationKey, 'alert-orphan', sandbox.providerWorkspaceId),
          leaseToken,
        );
        orphanProvidersTerminated += 1;
      }
    }

    for (const row of parsed.rows) {
      if (
        row.status === 'active' &&
        !parsed.providerSandboxes.some((sandbox) => sameProviderIdentity(row, sandbox))
      ) {
        await dependencies.markTerminated(
          MarkTerminatedInputSchema.parse({
            workspaceId: row.workspaceId,
            organizationId: row.organizationId,
            projectId: row.projectId,
            operationKey: childOperationKey(
              parsed.operationKey,
              'terminate-stale',
              row.workspaceId,
            ),
            leaseToken,
          }),
          true,
        );
        await dependencies.alert(
          ReconciliationAlertSchema.parse({
            kind: 'stale_database_row',
            workspaceId: row.workspaceId,
            organizationId: row.organizationId,
            projectId: row.projectId,
          }),
          childOperationKey(parsed.operationKey, 'alert-stale', row.workspaceId),
          leaseToken,
        );
        staleRowsTerminated += 1;
      }
    }
  } finally {
    await dependencies.releaseLeaderLease(leaseToken);
  }

  return { leaseAcquired: true, orphanProvidersTerminated, staleRowsTerminated };
}
