import { newId } from '@zapp/contracts';
import { capabilityScanActivityIdempotencyKey } from '@zapp/project-adapters';
import { describe, expect, it, vi } from 'vitest';

import { createTemporalCapabilityScanPort } from '../src/orchestrator/capability-scan.js';
import { TEST_CAPABILITY_SCAN } from './support/harness.js';

describe('VF-3 Temporal capability scan client', () => {
  it('starts the tenant scan on verification with a stable workflow identity', async () => {
    const organizationId = newId('org');
    const projectId = newId('proj');
    const scanId = 'scan-request-0001';
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
    const output = await TEST_CAPABILITY_SCAN.scan(input);
    const result = vi.fn(() => Promise.resolve(output));
    const start = vi.fn<(...args: unknown[]) => Promise<never>>(() =>
      Promise.resolve({ result } as never),
    );
    const port = createTemporalCapabilityScanPort({
      workflow: { start, getHandle: vi.fn() } as never,
    });

    await expect(port.scan(input)).resolves.toEqual(output);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0]).toBe('capabilityScanWorkflow');
    const options = start.mock.calls[0]?.[1] as {
      taskQueue: string;
      workflowId: string;
      workflowIdConflictPolicy: string;
      workflowIdReusePolicy: string;
      args: unknown[];
    };
    expect(options).toMatchObject({
      taskQueue: 'verification',
      workflowIdConflictPolicy: 'USE_EXISTING',
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      args: [input],
    });
    expect(options.workflowId).toMatch(/^capability-scan-[a-f0-9]{64}$/u);
    expect(result).toHaveBeenCalledOnce();
  });
});
