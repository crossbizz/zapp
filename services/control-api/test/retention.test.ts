import { describe, expect, it, vi } from 'vitest';

import {
  artifactExpiry,
  createArtifactRetentionJob,
  type ArtifactRetentionDatabase,
  type ArtifactRetentionObjectStore,
} from '../src/jobs/retention.js';

const organizationId = 'org_01J00000000000000000000000';
const projectId = 'proj_01J00000000000000000000000';

function candidate(
  artifactId: string,
  retentionClass: 'test' | 'diagnostic' = 'test',
) {
  return {
    artifactId,
    organizationId,
    projectId,
    retentionClass,
    storageRef: `org/${organizationId}/project/${projectId}/test/${artifactId}.json`,
    expiresAt: '2026-08-12T00:00:00.000Z',
  } as const;
}

describe('CP-17 nightly artifact retention', () => {
  it('fixes test artifacts at 30 days and diagnostics at 7 days', () => {
    const createdAt = new Date('2026-08-01T00:00:00.000Z');
    expect(artifactExpiry('test', createdAt).toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(artifactExpiry('diagnostic', createdAt).toISOString()).toBe(
      '2026-08-08T00:00:00.000Z',
    );
  });

  it('deletes exact objects, verifies absence, then removes rows', async () => {
    const first = candidate('art_01J00000000000000000000000');
    const second = candidate('art_01J00000000000000000000001', 'diagnostic');
    const removed: string[] = [];
    const removeVerified = vi.fn<(artifactId: string) => Promise<boolean>>((artifactId) => {
      removed.push(artifactId);
      return Promise.resolve(true);
    });
    const database: ArtifactRetentionDatabase = {
      listExpired: vi.fn(() => Promise.resolve([first, second])),
      removeVerified,
    };
    const deleted = new Set<string>();
    const deleteObject = vi.fn<(key: string) => Promise<void>>((key) => {
      deleted.add(key);
      return Promise.resolve();
    });
    const objectExists = vi.fn<(key: string) => Promise<boolean>>((key) =>
      Promise.resolve(!deleted.has(key)),
    );
    const objects: ArtifactRetentionObjectStore = {
      delete: deleteObject,
      exists: objectExists,
    };

    const result = await createArtifactRetentionJob({ database, objects }).run(
      new Date('2026-08-12T01:00:00.000Z'),
    );

    expect(result).toEqual({ deleted: 2, failed: 0 });
    expect(removed).toEqual([first.artifactId, second.artifactId]);
    expect(deleteObject).toHaveBeenNthCalledWith(1, first.storageRef);
    expect(objectExists).toHaveBeenNthCalledWith(1, first.storageRef);
  });

  it('keeps a row retryable when remote deletion fails or absence is unproven', async () => {
    const transportFailure = candidate('art_01J00000000000000000000002');
    const stillPresent = candidate('art_01J00000000000000000000003');
    const removeVerified = vi.fn(() => Promise.resolve(true));
    const database: ArtifactRetentionDatabase = {
      listExpired: () => Promise.resolve([transportFailure, stillPresent]),
      removeVerified,
    };
    const objects: ArtifactRetentionObjectStore = {
      delete: vi
        .fn<(key: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error('r2 unavailable'))
        .mockResolvedValueOnce(),
      exists: vi.fn(() => Promise.resolve(true)),
    };

    const result = await createArtifactRetentionJob({ database, objects }).run(
      new Date('2026-08-12T01:00:00.000Z'),
    );

    expect(result).toEqual({ deleted: 0, failed: 2 });
    expect(removeVerified).not.toHaveBeenCalled();
  });

  it('rejects a storage key outside its structurally bound tenant/project prefix', async () => {
    const unsafe = {
      ...candidate('art_01J00000000000000000000004'),
      storageRef: 'archives/agent-events/2026/01/do-not-delete.jsonl',
    };
    const deleteObject = vi.fn<(key: string) => Promise<void>>();
    const objects: ArtifactRetentionObjectStore = {
      delete: deleteObject,
      exists: vi.fn(),
    };
    const job = createArtifactRetentionJob({
      database: {
        listExpired: () => Promise.resolve([unsafe]),
        removeVerified: vi.fn(),
      },
      objects,
    });

    await expect(job.run(new Date('2026-08-12T01:00:00.000Z'))).rejects.toThrow(
      'artifact storage prefix mismatch',
    );
    expect(deleteObject).not.toHaveBeenCalled();
  });
});
