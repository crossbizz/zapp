import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

export const PROJECT_PACKAGE_CACHE_PATH = '/cache/pnpm' as const;

const ProjectVolumeInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    branchId: idSchema('br'),
  })
  .strict();

const ProjectVolumePlanSchema = z
  .object({
    volumeName: z.string().regex(/^vol-proj_proj_[0-9A-Z]+$/),
    mounts: z.tuple([
      z.object({ mountPath: z.literal('/cache'), subPath: z.literal('/cache') }).strict(),
    ]),
    workspaceRoot: z.string().startsWith('/workspace/br_'),
    lockFile: z.string().regex(/^\/workspace\/\.zapp-writer-br_[0-9A-Z]+\.lock$/u),
    sandboxName: z.string().regex(/^zapp-writer-[a-f0-9]{32}$/),
    environment: z
      .object({
        NPM_CONFIG_STORE_DIR: z.literal(PROJECT_PACKAGE_CACHE_PATH),
        PNPM_STORE_DIR: z.literal(PROJECT_PACKAGE_CACHE_PATH),
        PLAYWRIGHT_BROWSERS_PATH: z.literal('/cache/ms-playwright'),
      })
      .strict(),
  })
  .strict();

export type ProjectVolumePlan = z.infer<typeof ProjectVolumePlanSchema>;

export const BranchLockedResponseSchema = z
  .object({
    code: z.literal('branch_locked'),
    message: z.literal('The branch already has an active writer.'),
  })
  .strict();

export class BranchLockedError extends Error {
  readonly code = 'branch_locked' as const;

  constructor(readonly branchId: string) {
    super('The branch already has an active writer.');
    this.name = 'BranchLockedError';
  }
}

export function createProjectVolumePlan(untrustedInput: unknown): ProjectVolumePlan {
  const input = ProjectVolumeInputSchema.parse(untrustedInput);
  const workspaceRoot = posix.join('/workspace', input.branchId);
  const sandboxName = `zapp-writer-${createHash('sha256')
    .update(`${input.organizationId}:${input.projectId}:${input.branchId}`)
    .digest('hex')
    .slice(0, 32)}`;
  return ProjectVolumePlanSchema.parse({
    volumeName: projectVolumeName(input.projectId),
    mounts: [{ mountPath: '/cache', subPath: '/cache' }],
    workspaceRoot,
    lockFile: posix.join('/workspace', `.zapp-writer-${input.branchId}.lock`),
    sandboxName,
    environment: {
      NPM_CONFIG_STORE_DIR: PROJECT_PACKAGE_CACHE_PATH,
      PNPM_STORE_DIR: PROJECT_PACKAGE_CACHE_PATH,
      PLAYWRIGHT_BROWSERS_PATH: '/cache/ms-playwright',
    },
  });
}

export function projectVolumeName(projectId: string): string {
  return `vol-proj_${idSchema('proj').parse(projectId)}`;
}
