import { describe, expect, it } from 'vitest';

import {
  BranchLockedError,
  createProjectVolumePlan,
} from '../src/provider/volumes.js';

const ORGANIZATION_ID = 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NB';
const PROJECT_ID = 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NC';
const BRANCH_ID = 'br_01J8ME7YQZJ2V9Q0X3T5B6K7ND';

describe('WS-9 project cache volume and branch writer lock', () => {
  it('derives the one tenant-owned project Volume and branch working directory', () => {
    const plan = createProjectVolumePlan({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      branchId: BRANCH_ID,
    });
    expect(plan.sandboxName).toMatch(/^zapp-writer-[a-f0-9]{32}$/);
    expect({ ...plan, sandboxName: '<stable-hash>' }).toEqual({
      volumeName: `vol-proj_${PROJECT_ID}`,
      mounts: [
        { mountPath: '/cache', subPath: '/cache' },
      ],
      workspaceRoot: `/workspace/${BRANCH_ID}`,
      lockFile: `/workspace/.zapp-writer-${BRANCH_ID}.lock`,
      sandboxName: '<stable-hash>',
      environment: {
        NPM_CONFIG_STORE_DIR: '/cache/pnpm',
        PNPM_STORE_DIR: '/cache/pnpm',
        PLAYWRIGHT_BROWSERS_PATH: '/cache/ms-playwright',
      },
    });
    expect(plan.lockFile.startsWith(`${plan.workspaceRoot}/`)).toBe(false);
  });

  it('exposes a stable typed conflict for the HTTP 409 boundary', () => {
    const error = new BranchLockedError(BRANCH_ID);

    expect(error).toMatchObject({ code: 'branch_locked', branchId: BRANCH_ID });
    expect(error.message).not.toContain(PROJECT_ID);
  });
});
