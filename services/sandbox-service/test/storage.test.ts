import { describe, expect, it, vi } from 'vitest';

import {
  createProjectSnapshotDeletionService,
  createProjectStorageMeasurementService,
} from '../src/storage/measurements.js';

const scope = {
  organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
  projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
} as const;

describe('ADR-0030 project storage measurements', () => {
  it('combines persisted unexpired snapshot bytes with the read-only volume probe', async () => {
    const volume = vi.fn(() => Promise.resolve('17'));
    const service = createProjectStorageMeasurementService({
      snapshots: { record: () => Promise.resolve(), sumActiveBytes: () => Promise.resolve('13') },
      volumes: { measureProjectVolumeBytes: volume },
      now: () => new Date('2026-08-11T00:01:00.000Z'),
    });

    await expect(service.measureProjectBytes(scope)).resolves.toEqual({
      snapshotBytes: '13',
      volumeBytes: '17',
    });
    expect(volume).toHaveBeenCalledWith(scope);
  });
});

describe('CP-17 project snapshot deletion', () => {
  it('deletes every recorded image and drops its record only after verified absence', async () => {
    const rows = ['im-1', 'im-2'];
    const deleted: string[] = [];
    const service = createProjectSnapshotDeletionService({
      snapshots: {
        listProject: () => Promise.resolve([...rows]),
        removeVerified: (_scope, providerSnapshotId) => {
          rows.splice(rows.indexOf(providerSnapshotId), 1);
          return Promise.resolve(true);
        },
      },
      provider: {
        deleteSnapshot(providerSnapshotId) {
          deleted.push(providerSnapshotId);
          return Promise.resolve();
        },
        snapshotExists: () => Promise.resolve(false),
      },
    });

    await expect(service.remove(scope)).resolves.toBeUndefined();
    await expect(service.absent(scope)).resolves.toBe(true);
    expect(deleted).toEqual(['im-1', 'im-2']);
    expect(rows).toEqual([]);
  });

  it('retains the measurement when Modal still reports the image', async () => {
    let removed = false;
    const service = createProjectSnapshotDeletionService({
      snapshots: {
        listProject: () => Promise.resolve(['im-still-there']),
        removeVerified: () => {
          removed = true;
          return Promise.resolve(true);
        },
      },
      provider: {
        deleteSnapshot: () => Promise.resolve(),
        snapshotExists: () => Promise.resolve(true),
      },
    });
    await expect(service.remove(scope)).rejects.toThrow('snapshot remained after deletion');
    expect(removed).toBe(false);
  });
});
