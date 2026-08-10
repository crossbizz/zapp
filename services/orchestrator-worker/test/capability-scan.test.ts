import { createHash } from 'node:crypto';

import { newId } from '@zapp/contracts';
import { capabilityScanActivityIdempotencyKey } from '@zapp/project-adapters';
import { describe, expect, it, vi } from 'vitest';

import { createCapabilityScanActivities } from '../src/activities/capability-scan.js';

describe('VF-3 capability scan activity', () => {
  it('scans an owned workspace, uploads the report, and closes the workspace', async () => {
    const close = vi.fn(() => Promise.resolve());
    const put = vi.fn<
      (input: { storageRef: string; body: Uint8Array; contentHash: string }) => Promise<void>
    >(() => Promise.resolve());
    const organizationId = newId('org');
    const projectId = newId('proj');
    const scanId = 'scan-activity-0001';
    const input = {
      scanId,
      idempotencyKey: capabilityScanActivityIdempotencyKey({ organizationId, projectId, scanId }),
      organizationId,
      projectId,
      branchId: newId('br'),
      branchName: 'main',
      workspaceId: newId('ws'),
      runId: newId('run'),
      taskId: newId('task'),
      workspaceCreatedAt: '2026-08-10T00:00:00.000Z',
    };
    const manifest = JSON.stringify({
      name: 'activity-fixture',
      scripts: { build: 'build', typecheck: 'typecheck', test: 'test' },
    });
    const activities = createCapabilityScanActivities({
      workspaces: {
        open: () =>
          Promise.resolve({
            workspaceRoot: '.',
            listFiles: () => Promise.resolve(['package.json', 'pnpm-lock.yaml']),
            readFile: (path: string) => Promise.resolve(path === 'package.json' ? manifest : ''),
            close,
          }),
      },
      reports: { put },
    });

    const output = await activities.scanProjectCapabilities(input);

    expect(output.result.contract).toMatchObject({ package_manager: 'pnpm' });
    expect(output.reportArtifact.storageRef).toBe(
      `org/${input.organizationId}/project/${input.projectId}/capability-scan/${input.scanId}.json`,
    );
    expect(put).toHaveBeenCalledOnce();
    const uploaded = put.mock.calls[0]?.[0];
    expect(uploaded?.contentHash).toBe(
      createHash('sha256').update(uploaded?.body ?? new Uint8Array()).digest('hex'),
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
