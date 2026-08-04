import type { WorkspaceStatus } from '@zapp/contracts';
import type { Workspace } from '@zapp/db';

/** Public workspace lifecycle only; raw filesystem and command access stay internal. */
export interface SandboxServicePort {
  createWorkspace(input: {
    readonly workspace: Workspace;
  }): Promise<{ readonly providerWorkspaceId: string; readonly status: WorkspaceStatus }>;
  startWorkspace(input: {
    readonly workspace: Workspace;
  }): Promise<{ readonly status: WorkspaceStatus }>;
  checkpointWorkspace(input: {
    readonly workspace: Workspace;
    readonly kind: 'active' | 'diagnostic' | 'release_evidence';
  }): Promise<{ readonly snapshotRef: string }>;
  terminateWorkspace(input: { readonly workspace: Workspace }): Promise<void>;
  previewWorkspace(input: {
    readonly workspace: Workspace;
    readonly port: number;
    readonly ttlSeconds: number;
    readonly userId: string;
  }): Promise<{ readonly url: string; readonly expiresAt: string }>;
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
