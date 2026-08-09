import { describe, expect, it } from 'vitest';
import {
  CheckpointKindSchema,
  CreateWorkspaceInputSchema,
  NetworkProfileSchema,
  RESOURCE_PROFILES,
  ResourceProfileSchema,
  WorkspacePurposeSchema,
  WorkspaceStatusSchema,
} from '../src/sandbox.js';

// The lists and the profile table below are written out rather than derived from
// the source: they are the contract, so any edit has to fail here first.

const createInput = {
  organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
  projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
  branchId: 'main',
  purpose: 'builder',
  resourceProfile: 'standard',
  imageTag: 'forge-node-base:2026-08-15-a1b2c3',
  env: { PNPM_STORE_DIR: '/cache/pnpm' },
  networkProfile: 'dependency_install',
};

describe('WorkspaceStatusSchema', () => {
  it('is exactly the PRD §18.9 lifecycle, in order', () => {
    expect(WorkspaceStatusSchema.options).toEqual([
      'requested',
      'provisioning',
      'started',
      'ready',
      'active',
      'checkpointing',
      'idle',
      'terminated',
    ]);
  });

  it('rejects a state outside the lifecycle', () => {
    expect(WorkspaceStatusSchema.safeParse('failed').success).toBe(false);
  });
});

describe('RESOURCE_PROFILES', () => {
  it('is exactly the PRD §18.10 cpu and memory table', () => {
    expect(RESOURCE_PROFILES).toEqual({
      small: { cpuRequest: 0.5, cpuLimit: 2, memRequestGiB: 1, memLimitGiB: 4 },
      standard: { cpuRequest: 1, cpuLimit: 4, memRequestGiB: 2, memLimitGiB: 8 },
      large: { cpuRequest: 2, cpuLimit: 8, memRequestGiB: 4, memLimitGiB: 16 },
    });
  });

  it('has one entry per profile name', () => {
    expect(Object.keys(RESOURCE_PROFILES)).toEqual(ResourceProfileSchema.options);
  });
});

describe('ResourceProfileSchema', () => {
  it('is exactly small, standard and large, in order', () => {
    expect(ResourceProfileSchema.options).toEqual(['small', 'standard', 'large']);
  });
});

describe('NetworkProfileSchema', () => {
  it('is exactly the PRD §18.11 profiles, in order', () => {
    expect(NetworkProfileSchema.options).toEqual([
      'dependency_install',
      'build_test',
      'restricted_verification',
    ]);
  });

  it('rejects a profile outside the list', () => {
    expect(NetworkProfileSchema.safeParse('unrestricted').success).toBe(false);
  });
});

describe('CheckpointKindSchema', () => {
  it('is exactly the PRD §18.8 retention classes, in order', () => {
    expect(CheckpointKindSchema.options).toEqual(['active', 'diagnostic', 'release_evidence']);
  });
});

describe('WorkspacePurposeSchema', () => {
  it('is exactly builder, verifier, preview and scan, in order', () => {
    expect(WorkspacePurposeSchema.options).toEqual(['builder', 'verifier', 'preview', 'scan']);
  });
});

describe('CreateWorkspaceInputSchema', () => {
  it('accepts a workspace request without a run or task', () => {
    expect(CreateWorkspaceInputSchema.parse(createInput)).toEqual(createInput);
  });

  it('accepts the optional run and task attribution', () => {
    const attributed = {
      ...createInput,
      runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7N9',
      taskId: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
    };
    expect(CreateWorkspaceInputSchema.parse(attributed)).toEqual(attributed);
  });

  it('leaves absent optional identifiers absent instead of setting undefined', () => {
    const parsed = CreateWorkspaceInputSchema.parse(createInput);
    expect('runId' in parsed).toBe(false);
    expect('taskId' in parsed).toBe(false);
  });

  it('rejects identifiers carrying the wrong prefix', () => {
    expect(
      CreateWorkspaceInputSchema.safeParse({
        ...createInput,
        organizationId: createInput.projectId,
      }).success,
    ).toBe(false);
    expect(
      CreateWorkspaceInputSchema.safeParse({
        ...createInput,
        runId: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty branch or image tag', () => {
    expect(CreateWorkspaceInputSchema.safeParse({ ...createInput, branchId: '' }).success).toBe(
      false,
    );
    expect(CreateWorkspaceInputSchema.safeParse({ ...createInput, imageTag: '' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown purpose, profile or network profile', () => {
    expect(
      CreateWorkspaceInputSchema.safeParse({ ...createInput, purpose: 'deployer' }).success,
    ).toBe(false);
    expect(
      CreateWorkspaceInputSchema.safeParse({ ...createInput, resourceProfile: 'xlarge' }).success,
    ).toBe(false);
    expect(
      CreateWorkspaceInputSchema.safeParse({ ...createInput, networkProfile: 'open' }).success,
    ).toBe(false);
  });

  it('rejects env values that are not strings', () => {
    expect(
      CreateWorkspaceInputSchema.safeParse({ ...createInput, env: { PORT: 3000 } }).success,
    ).toBe(false);
  });

  it('rejects a request missing a required field', () => {
    const withoutProjectId: Partial<typeof createInput> = { ...createInput };
    delete withoutProjectId.projectId;
    expect(CreateWorkspaceInputSchema.safeParse(withoutProjectId).success).toBe(false);
  });
});
