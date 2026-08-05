import { describe, expect, it, vi } from 'vitest';

import {
  createBackupOperations,
  createPostgresRestoreDrillLease,
  type RestoreDrillLease,
} from '../scripts/backup.js';
import type { BackupObjectStore } from '../src/backup.js';
import { createFakeForgejo } from './support/fake-forgejo.js';

interface ReservedSqlDouble {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<readonly unknown[]>;
  release(): void;
}

const unusedStore: BackupObjectStore = {
  exists: () => Promise.reject(new Error('not used')),
  put: () => Promise.reject(new Error('not used')),
  get: () => Promise.reject(new Error('not used')),
  list: () => Promise.reject(new Error('not used')),
  delete: () => Promise.reject(new Error('restore state is append-only')),
};

describe('the restore-drill lease', () => {
  it('holds one exclusive lease before reading inventory and releases it after a crash', async () => {
    let held = false;
    let inventoryCalls = 0;
    let releaseInventory: ((value: readonly []) => void) | undefined;
    const pendingInventory = new Promise<readonly []>((resolve) => {
      releaseInventory = resolve;
    });
    const lease: RestoreDrillLease = {
      runExclusive: async (operation) => {
        if (held) {
          throw new Error('Restore drill is already in progress');
        }
        held = true;
        try {
          return await operation();
        } finally {
          held = false;
        }
      },
    };
    const operations = createBackupOperations({
      inventory: {
        listProvisionedRepositories: () => {
          inventoryCalls += 1;
          return inventoryCalls === 1 ? pendingInventory : Promise.resolve([]);
        },
        expectedBranches: () => Promise.resolve([]),
      },
      store: unusedStore,
      git: {
        createBundle: () => Promise.reject(new Error('not used')),
        verifyBundle: () => Promise.reject(new Error('not used')),
        mirrorPush: () => Promise.reject(new Error('not used')),
        remoteRefs: () => Promise.reject(new Error('not used')),
      },
      client: createFakeForgejo(),
      restoreCredentials: {
        issue: () => Promise.reject(new Error('not used')),
      },
      restoreDrillLease: lease,
      close: () => Promise.resolve(),
    });

    const first = operations.restoreDrill();
    await vi.waitFor(() => {
      expect(inventoryCalls).toBe(1);
    });
    await expect(operations.restoreDrill()).rejects.toThrow('Restore drill is already in progress');
    expect(inventoryCalls).toBe(1);

    releaseInventory?.([]);
    await expect(first).rejects.toThrow('No provisioned internal repository');
    await expect(operations.restoreDrill()).rejects.toThrow('No provisioned internal repository');
    expect(inventoryCalls).toBe(2);
  });

  it('uses one reserved PostgreSQL session and releases it after operation failure', async () => {
    const queries: string[] = [];
    let released = 0;
    const session = Object.assign(
      (strings: TemplateStringsArray) => {
        const query = strings.join('?');
        queries.push(query);
        return Promise.resolve(
          query.includes('pg_try_advisory_lock') ? [{ acquired: true }] : [{ released: true }],
        );
      },
      {
        release: () => {
          released += 1;
        },
      },
    ) as ReservedSqlDouble;
    const lease = createPostgresRestoreDrillLease({
      reserve: () => Promise.resolve(session),
    } as unknown as Parameters<typeof createPostgresRestoreDrillLease>[0]);

    await expect(
      lease.runExclusive(() => Promise.reject(new Error('simulated process failure'))),
    ).rejects.toThrow('simulated process failure');

    expect(queries).toEqual([
      expect.stringContaining('pg_try_advisory_lock'),
      expect.stringContaining('pg_advisory_unlock'),
    ]);
    expect(released).toBe(1);
  });

  it('rejects a contender without running it or unlocking another session owner', async () => {
    const queries: string[] = [];
    let released = 0;
    let invoked = false;
    const session = Object.assign(
      (strings: TemplateStringsArray) => {
        queries.push(strings.join('?'));
        return Promise.resolve([{ acquired: false }]);
      },
      {
        release: () => {
          released += 1;
        },
      },
    ) as ReservedSqlDouble;
    const lease = createPostgresRestoreDrillLease({
      reserve: () => Promise.resolve(session),
    } as unknown as Parameters<typeof createPostgresRestoreDrillLease>[0]);

    await expect(
      lease.runExclusive(() => {
        invoked = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow('Restore drill is already in progress');
    expect(invoked).toBe(false);
    expect(queries).toEqual([expect.stringContaining('pg_try_advisory_lock')]);
    expect(released).toBe(1);
  });
});
