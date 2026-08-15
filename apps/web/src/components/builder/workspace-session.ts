import type { ProjectWorkspace } from '../../lib/api';

export type { ProjectWorkspace } from '../../lib/api';

const readableWorkspaceStatuses = new Set<ProjectWorkspace['status']>([
  'started',
  'ready',
  'active',
  'idle',
]);

interface ProjectWorkspaceClient {
  createWorkspace(
    projectId: string,
    branchId: string,
    idempotencyKey?: string,
  ): Promise<{ readonly workspace: ProjectWorkspace }>;
  listProjectWorkspaces(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly workspaces: readonly ProjectWorkspace[] }>;
}

interface WorkspaceRestartClient {
  restartDevServer(workspaceId: string, idempotencyKey?: string): Promise<unknown>;
}

const workspaceRecoveryCacheTtlMs = 30_000;
const workspaceAutoWakeTtlMs = 30_000;
const workspaceRecoveryCache = new Map<
  string,
  { readonly expiresAt: number; readonly workspace: ProjectWorkspace }
>();
const workspaceRecoveryRequests = new Map<
  string,
  Promise<{ readonly recovered: true; readonly workspace: ProjectWorkspace }>
>();
const recoveredWorkspaceRestarts = new Map<
  string,
  { expiresAt: number; readonly restart: Promise<void> }
>();

interface WorkspaceWakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function claimWorkspaceAutoWake(
  storage: WorkspaceWakeStorage,
  workspaceId: string,
  now = Date.now(),
): boolean {
  const key = `zapp:preview:auto-wake:${workspaceId}`;
  try {
    const previous = Number(storage.getItem(key));
    if (Number.isFinite(previous) && previous > 0 && now - previous < workspaceAutoWakeTtlMs) {
      return false;
    }
    storage.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}

export function selectProjectWorkspace(
  workspaces: readonly ProjectWorkspace[],
  branchId?: string,
  preferredWorkspaceId?: string,
): ProjectWorkspace | undefined {
  const readable = workspaces.filter(
    (workspace) =>
      (branchId === undefined || workspace.branchId === branchId) &&
      workspace.providerWorkspaceId !== null &&
      workspace.terminatedAt === null &&
      readableWorkspaceStatuses.has(workspace.status),
  );
  return readable.find((workspace) => workspace.id === preferredWorkspaceId) ?? readable.at(0);
}

export async function ensureProjectWorkspace(
  client: ProjectWorkspaceClient,
  input: {
    readonly branchId: string;
    readonly preferredWorkspaceId?: string;
    readonly projectId: string;
    readonly signal?: AbortSignal;
  },
): Promise<{ readonly recovered: boolean; readonly workspace: ProjectWorkspace }> {
  const listed = await client.listProjectWorkspaces(input.projectId, input.signal);
  const workspace = selectProjectWorkspace(
    listed.workspaces,
    input.branchId,
    input.preferredWorkspaceId,
  );
  if (workspace !== undefined) return { recovered: false, workspace };
  if (input.signal?.aborted === true) throw new DOMException('Aborted', 'AbortError');
  const recoveryKey = `${input.projectId}:${input.branchId}`;
  const cached = workspaceRecoveryCache.get(recoveryKey);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return { recovered: true, workspace: cached.workspace };
  }
  const pending = workspaceRecoveryRequests.get(recoveryKey);
  if (pending !== undefined) return pending;
  const recovery = client
    .createWorkspace(input.projectId, input.branchId, crypto.randomUUID())
    .then(({ workspace: createdWorkspace }) => {
      workspaceRecoveryCache.set(recoveryKey, {
        expiresAt: Date.now() + workspaceRecoveryCacheTtlMs,
        workspace: createdWorkspace,
      });
      return { recovered: true as const, workspace: createdWorkspace };
    })
    .finally(() => {
      workspaceRecoveryRequests.delete(recoveryKey);
    });
  workspaceRecoveryRequests.set(recoveryKey, recovery);
  return recovery;
}

export function restartWorkspaceOnce(
  client: WorkspaceRestartClient,
  workspaceId: string,
): Promise<void> {
  const cached = recoveredWorkspaceRestarts.get(workspaceId);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.restart;
  const restart = client
    .restartDevServer(workspaceId, crypto.randomUUID())
    .then(() => undefined)
    .then(() => {
      const completed = recoveredWorkspaceRestarts.get(workspaceId);
      if (completed !== undefined) {
        completed.expiresAt = Date.now() + workspaceRecoveryCacheTtlMs;
      }
    })
    .catch((error: unknown) => {
      recoveredWorkspaceRestarts.delete(workspaceId);
      throw error;
    });
  recoveredWorkspaceRestarts.set(workspaceId, { expiresAt: Number.POSITIVE_INFINITY, restart });
  return restart;
}
