import { createHash } from 'node:crypto';

import type { DetectionContext } from '@zapp/contracts';
import {
  CapabilityScanInputSchema,
  CapabilityScanOutputSchema,
  capabilityScanArtifactStorageRef,
  scanProjectCapabilities,
  type CapabilityScanInput,
  type CapabilityScanOutput,
} from '@zapp/project-adapters';

export interface CapabilityScanWorkspace extends DetectionContext {
  close(): Promise<void>;
}

export interface CapabilityScanWorkspacePort {
  open(input: CapabilityScanInput): Promise<CapabilityScanWorkspace>;
}

export interface CapabilityScanReportStore {
  put(input: {
    readonly storageRef: string;
    readonly body: Uint8Array;
    readonly contentHash: string;
  }): Promise<void>;
}

export interface CapabilityScanActivities {
  scanProjectCapabilities(input: CapabilityScanInput): Promise<CapabilityScanOutput>;
}

export function createCapabilityScanActivities(deps: {
  readonly workspaces: CapabilityScanWorkspacePort;
  readonly reports: CapabilityScanReportStore;
}): CapabilityScanActivities {
  return {
    async scanProjectCapabilities(inputValue) {
      const input = CapabilityScanInputSchema.parse(inputValue);
      const workspace = await deps.workspaces.open(input);
      try {
        const result = await scanProjectCapabilities(workspace);
        const body = Buffer.from(JSON.stringify(result), 'utf8');
        const contentHash = createHash('sha256').update(body).digest('hex');
        const storageRef = capabilityScanArtifactStorageRef(input);
        await deps.reports.put({ storageRef, body, contentHash });
        return CapabilityScanOutputSchema.parse({
          result,
          reportArtifact: { storageRef, contentHash },
        });
      } finally {
        await workspace.close();
      }
    },
  };
}
