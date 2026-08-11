import { describe, expect, it, vi } from 'vitest';

import { createProjectStorageMeasurementService } from '../src/storage/measurements.js';

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
