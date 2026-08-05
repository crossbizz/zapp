import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { internalRepoRef, newId } from '@zapp/contracts';
import { describe, expect, it, vi } from 'vitest';

import * as backupScript from '../scripts/backup.js';
import type {
  BackupGit,
  BackupInventory,
  BackupObject,
  BackupObjectStore,
  BackupPutResult,
  BackupRepository,
  BackupUploadSource,
  CreatedRestoreTarget,
} from '../src/backup.js';
import type { ForgejoClient } from '../src/forgejo/client.js';
import { createFakeForgejo } from './support/fake-forgejo.js';

const SOURCE_ORGANIZATION_ID = newId('org');
const SOURCE_PROJECT_ID = newId('proj');
const SOURCE: BackupRepository = {
  organizationId: SOURCE_ORGANIZATION_ID,
  projectId: SOURCE_PROJECT_ID,
  internalRepoRef: internalRepoRef({
    organizationId: SOURCE_ORGANIZATION_ID,
    projectId: SOURCE_PROJECT_ID,
  }),
  cloneUrl: 'https://git.test/source/repository.git',
  defaultBranch: 'main',
};
const DRILL_MARKER_KEY = `org/${SOURCE.organizationId}/project/${SOURCE.projectId}/git-restore-drills/quarterly-v1.json`;
const DRILL_DESCRIPTION = `zapp.build restore drill ${createHash('sha256')
  .update(DRILL_MARKER_KEY)
  .digest('hex')
  .slice(0, 32)}`;

class MarkerStore implements BackupObjectStore {
  readonly values = new Map<string, Buffer>();
  readonly deletes: string[] = [];
  listing?: (prefix: string) => Promise<{ readonly objects: readonly BackupObject[] }>;

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.values.has(key));
  }

  async put(key: string, source: BackupUploadSource): Promise<BackupPutResult> {
    if (this.values.has(key)) {
      return 'existing';
    }
    const chunks: Buffer[] = [];
    for await (const chunk of source.open()) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    this.values.set(key, Buffer.concat(chunks));
    return 'created';
  }

  get(key: string): Promise<Readable> {
    const value = this.values.get(key);
    return value === undefined
      ? Promise.reject(new Error('marker missing'))
      : Promise.resolve(Readable.from(value));
  }

  list(prefix: string): Promise<{ readonly objects: readonly BackupObject[] }> {
    return this.listing?.(prefix) ?? Promise.resolve({ objects: [] });
  }

  delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.values.delete(key);
    return Promise.resolve();
  }
}

interface PreparedDrillTarget {
  readonly markerKey: string;
  readonly ownershipKey: string;
  readonly targetRef: string;
  readonly target: CreatedRestoreTarget & { readonly repositoryId: number };
  clearMarker(): Promise<void>;
}

type PrepareRestoreDrillTarget = (
  deps: { readonly store: BackupObjectStore; readonly client: ForgejoClient },
  source: BackupRepository,
) => Promise<PreparedDrillTarget>;

type CreateBackupOperations = (deps: {
  readonly inventory: BackupInventory;
  readonly store: BackupObjectStore;
  readonly git: BackupGit;
  readonly client: ForgejoClient;
  readonly restoreDrillLease: RestoreDrillLease;
  readonly close: () => Promise<void>;
}) => backupScript.BackupCliOperations;

interface RestoreDrillLease {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

interface ReservedSqlDouble {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<readonly unknown[]>;
  release(): void;
}

type CreatePostgresRestoreDrillLease = (sql: {
  reserve(): Promise<ReservedSqlDouble>;
}) => RestoreDrillLease;

const passThroughLease: RestoreDrillLease = {
  runExclusive: async (operation) => await operation(),
};

function preparer(): PrepareRestoreDrillTarget | undefined {
  return (backupScript as { readonly prepareRestoreDrillTarget?: PrepareRestoreDrillTarget })
    .prepareRestoreDrillTarget;
}

async function prepare(
  store: BackupObjectStore,
  client: ForgejoClient,
): Promise<PreparedDrillTarget> {
  const operation = preparer();
  expect(operation, 'durable restore-drill preparation is missing').toBeTypeOf('function');
  if (operation === undefined) {
    throw new Error('durable restore-drill preparation is missing');
  }
  return await operation({ store, client }, SOURCE);
}

describe('durable restore-drill ownership', () => {
  it('reconciles a marker-owned target after a simulated crash, then clears only owned state', async () => {
    const store = new MarkerStore();
    const forgejo = createFakeForgejo({
      'POST /orgs': { status: 201, body: {} },
      'POST /orgs/*/repos': {
        status: 201,
        body: {
          id: 101,
          clone_url: 'https://git.test/drill/repository.git',
          empty: true,
          description: DRILL_DESCRIPTION,
        },
      },
    });
    const first = await prepare(store, forgejo);
    const createCall = forgejo.calls.find((call) => call.path.endsWith('/repos'));
    const description = (createCall?.body as { readonly description?: unknown } | undefined)
      ?.description;
    expect(description).toEqual(expect.any(String));
    expect(store.values.has(first.markerKey)).toBe(true);
    expect(store.values.has(first.ownershipKey)).toBe(true);
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);

    // Process exit here: the first target handle is deliberately discarded.
    const [owner, name] = first.targetRef.split('/') as [string, string];
    forgejo.route(`GET /repos/${owner}/${name}`, {
      status: 200,
      body: {
        id: 101,
        clone_url: `https://git.test/${first.targetRef}.git`,
        empty: false,
        description,
      },
      then: {
        status: 200,
        body: {
          id: 101,
          clone_url: `https://git.test/${first.targetRef}.git`,
          empty: false,
          description,
        },
        then: {
          status: 404,
          then: {
            status: 200,
            body: {
              id: 102,
              clone_url: `https://git.test/${first.targetRef}.git`,
              empty: false,
              description,
            },
          },
        },
      },
    });
    forgejo.route(`POST /orgs/${owner}/repos`, {
      status: 201,
      body: {
        id: 102,
        clone_url: `https://git.test/${first.targetRef}.git`,
        empty: true,
        description,
      },
    });
    forgejo.route(`DELETE /repos/${owner}/${name}`, { status: 204 });

    const retry = await prepare(store, forgejo);
    expect(retry.markerKey).toBe(first.markerKey);
    expect(retry.ownershipKey).toBe(first.ownershipKey);
    expect(retry.targetRef).toBe(first.targetRef);
    expect(retry.target.repositoryId).toBe(102);
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);

    await retry.target.compensate();
    await retry.clearMarker();

    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toHaveLength(2);
    expect(store.deletes).toEqual([first.ownershipKey, first.ownershipKey, first.markerKey]);
    expect(store.values.has(first.markerKey)).toBe(false);
  });

  it('never deletes an unmarked repository that occupies the deterministic target', async () => {
    const store = new MarkerStore();
    const forgejo = createFakeForgejo({ 'POST /orgs': { status: 201, body: {} } });

    // Acquire the durable marker, then fail before repository creation.
    forgejo.route('POST /orgs/*/repos', { error: new Error('simulated process loss') });
    await expect(prepare(store, forgejo)).rejects.toThrow('simulated process loss');
    expect(store.values.size).toBe(1);

    const repositoryGet = forgejo.calls.find(
      (call) => call.method === 'GET' && call.path.startsWith('/repos/'),
    );
    expect(repositoryGet).toBeDefined();
    forgejo.route(`GET ${repositoryGet?.path ?? ''}`, {
      status: 200,
      body: {
        id: 101,
        clone_url: 'https://git.test/pre-existing/repository.git',
        empty: true,
        description: DRILL_DESCRIPTION,
      },
    });

    await expect(prepare(store, forgejo)).rejects.toThrow(
      'restore drill target has no immutable ownership receipt',
    );
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(store.values.size).toBe(1);
  });

  it('preserves a replacement that occupies a stale marker-owned path', async () => {
    const store = new MarkerStore();
    const forgejo = createFakeForgejo({
      'POST /orgs': { status: 201, body: {} },
      'POST /orgs/*/repos': {
        status: 201,
        body: {
          id: 101,
          clone_url: 'https://git.test/drill/repository.git',
          empty: true,
          description: DRILL_DESCRIPTION,
        },
      },
    });
    const first = await prepare(store, forgejo);
    const [owner, name] = first.targetRef.split('/') as [string, string];
    forgejo.route(`GET /repos/${owner}/${name}`, {
      status: 200,
      body: {
        id: 202,
        clone_url: `https://git.test/${first.targetRef}.git`,
        empty: true,
        description: DRILL_DESCRIPTION,
      },
    });
    forgejo.route(`DELETE /repos/${owner}/${name}`, { status: 204 });

    await expect(prepare(store, forgejo)).rejects.toThrow('restore target ownership was lost');
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(store.values.has(first.markerKey)).toBe(true);
    expect(store.values.has(first.ownershipKey)).toBe(true);
  });

  it('re-reads immutable ownership immediately before stale reconciliation deletion', async () => {
    const store = new MarkerStore();
    const forgejo = createFakeForgejo({
      'POST /orgs': { status: 201, body: {} },
      'POST /orgs/*/repos': {
        status: 201,
        body: {
          id: 101,
          clone_url: 'https://git.test/drill/repository.git',
          empty: true,
          description: DRILL_DESCRIPTION,
        },
      },
    });
    const first = await prepare(store, forgejo);
    const [owner, name] = first.targetRef.split('/') as [string, string];
    forgejo.route(`GET /repos/${owner}/${name}`, {
      status: 200,
      body: {
        id: 101,
        clone_url: `https://git.test/${first.targetRef}.git`,
        empty: true,
        description: DRILL_DESCRIPTION,
      },
      then: {
        status: 200,
        body: {
          id: 202,
          clone_url: `https://git.test/${first.targetRef}.git`,
          empty: true,
          description: DRILL_DESCRIPTION,
        },
      },
    });
    forgejo.route(`DELETE /repos/${owner}/${name}`, { status: 204 });

    await expect(prepare(store, forgejo)).rejects.toThrow('restore target ownership was lost');
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(store.values.has(first.ownershipKey)).toBe(true);
  });

  it('routes the real quarterly-drill operation through durable ownership and exact cleanup', async () => {
    const factory = (backupScript as { readonly createBackupOperations?: CreateBackupOperations })
      .createBackupOperations;
    expect(factory, 'production drill operations do not expose an injectable callsite').toBeTypeOf(
      'function',
    );
    if (factory === undefined) {
      throw new Error('production drill operations do not expose an injectable callsite');
    }

    const backupKey = `org/${SOURCE.organizationId}/project/${SOURCE.projectId}/git-backups/2026-08-04.bundle`;
    const store = new MarkerStore();
    store.values.set(backupKey, Buffer.from('bundle bytes'));
    store.listing = (prefix: string) =>
      Promise.resolve({
        objects: [...store.values.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key, lastModified: new Date('2026-08-04T09:30:00.000Z') })),
      });
    const forgejo = createFakeForgejo({
      'POST /orgs': { status: 201, body: {} },
      'POST /orgs/*/repos': {
        status: 201,
        body: {
          id: 101,
          clone_url: 'https://git.test/drill/repository.git',
          empty: true,
          description: DRILL_DESCRIPTION,
        },
      },
      'GET /repos/*/*': {
        status: 404,
        then: {
          status: 404,
          then: {
            status: 200,
            body: {
              id: 101,
              clone_url: 'https://git.test/drill/repository.git',
              empty: false,
              description: DRILL_DESCRIPTION,
            },
          },
        },
      },
      'DELETE /repos/*/*': { status: 204 },
    });
    const operations = factory({
      inventory: {
        listProvisionedRepositories: () => Promise.resolve([SOURCE]),
        expectedBranches: () => Promise.resolve([{ name: 'main', headCommitSha: 'a'.repeat(40) }]),
      },
      store,
      git: {
        createBundle: () => Promise.reject(new Error('not used')),
        verifyBundle: () => Promise.resolve(),
        mirrorPush: () => Promise.resolve(),
        remoteRefs: () => Promise.resolve(new Map([['refs/heads/main', 'a'.repeat(40)]])),
      },
      client: forgejo,
      restoreDrillLease: passThroughLease,
      close: () => Promise.resolve(),
    });

    await expect(operations.restoreDrill()).resolves.toMatchObject({
      status: 'restore-drill-verified',
      checkedBranches: 1,
    });
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
    expect(store.deletes).toHaveLength(2);
    expect(store.deletes).toEqual([
      expect.stringContaining('/git-restore-drills/quarterly-v1.ownership.json'),
      expect.stringContaining('/git-restore-drills/quarterly-v1.json'),
    ]);
    expect([...store.values.keys()]).toEqual([backupKey]);
  });

  it('preserves a replacement installed before the real drill finally cleanup', async () => {
    const factory = (backupScript as { readonly createBackupOperations?: CreateBackupOperations })
      .createBackupOperations;
    expect(factory).toBeTypeOf('function');
    if (factory === undefined) {
      throw new Error('production drill operations do not expose an injectable callsite');
    }

    const backupKey = `org/${SOURCE.organizationId}/project/${SOURCE.projectId}/git-backups/2026-08-04.bundle`;
    const store = new MarkerStore();
    store.values.set(backupKey, Buffer.from('bundle bytes'));
    store.listing = () =>
      Promise.resolve({
        objects: [{ key: backupKey, lastModified: new Date('2026-08-04T09:30:00.000Z') }],
      });
    const forgejo = createFakeForgejo({
      'POST /orgs': { status: 201, body: {} },
      'GET /repos/*/*': { status: 404 },
      'POST /orgs/*/repos': {
        status: 201,
        body: {
          id: 101,
          clone_url: 'https://git.test/drill/repository.git',
          empty: true,
          description: DRILL_DESCRIPTION,
        },
      },
      'DELETE /repos/*/*': { status: 204 },
    });
    const operations = factory({
      inventory: {
        listProvisionedRepositories: () => Promise.resolve([SOURCE]),
        expectedBranches: () => Promise.resolve([{ name: 'main', headCommitSha: 'a'.repeat(40) }]),
      },
      store,
      git: {
        createBundle: () => Promise.reject(new Error('not used')),
        verifyBundle: () => Promise.resolve(),
        mirrorPush: () => Promise.resolve(),
        remoteRefs: () => {
          forgejo.route('GET /repos/*/*', {
            status: 200,
            body: {
              id: 202,
              clone_url: 'https://git.test/replacement/repository.git',
              empty: false,
              description: DRILL_DESCRIPTION,
            },
          });
          return Promise.resolve(new Map([['refs/heads/main', 'a'.repeat(40)]]));
        },
      },
      client: forgejo,
      restoreDrillLease: passThroughLease,
      close: () => Promise.resolve(),
    });

    await expect(operations.restoreDrill()).rejects.toThrow('restore target ownership was lost');
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect([...store.values.keys()]).toEqual(
      expect.arrayContaining([
        backupKey,
        DRILL_MARKER_KEY,
        `${DRILL_MARKER_KEY.slice(0, -5)}.ownership.json`,
      ]),
    );
  });

  it('holds one exclusive lease across the entire real drill operation', async () => {
    const factory = (backupScript as { readonly createBackupOperations?: CreateBackupOperations })
      .createBackupOperations;
    expect(factory).toBeTypeOf('function');
    if (factory === undefined) {
      throw new Error('production drill operations do not expose an injectable callsite');
    }

    let releaseInventory: ((repositories: readonly BackupRepository[]) => void) | undefined;
    let inventoryCalls = 0;
    const firstInventory = new Promise<readonly BackupRepository[]>((resolve) => {
      releaseInventory = resolve;
    });
    let held = false;
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
    const forgejo = createFakeForgejo();
    const operations = factory({
      inventory: {
        listProvisionedRepositories: () => {
          inventoryCalls += 1;
          return inventoryCalls === 1 ? firstInventory : Promise.resolve([]);
        },
        expectedBranches: () => Promise.resolve([]),
      },
      store: new MarkerStore(),
      git: {
        createBundle: () => Promise.reject(new Error('not used')),
        verifyBundle: () => Promise.resolve(),
        mirrorPush: () => Promise.resolve(),
        remoteRefs: () => Promise.resolve(new Map()),
      },
      client: forgejo,
      restoreDrillLease: lease,
      close: () => Promise.resolve(),
    });

    const first = operations.restoreDrill();
    await vi.waitFor(() => {
      expect(inventoryCalls).toBe(1);
    });
    await expect(operations.restoreDrill()).rejects.toThrow('Restore drill is already in progress');
    expect(inventoryCalls).toBe(1);
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);

    releaseInventory?.([]);
    await expect(first).rejects.toThrow('No provisioned internal repository');
    await expect(operations.restoreDrill()).rejects.toThrow('No provisioned internal repository');
    expect(inventoryCalls).toBe(2);
  });
});

describe('the PostgreSQL restore-drill lease', () => {
  it('uses one reserved session and releases it after operation failure', async () => {
    const factory = (
      backupScript as unknown as {
        readonly createPostgresRestoreDrillLease?: CreatePostgresRestoreDrillLease;
      }
    ).createPostgresRestoreDrillLease;
    expect(factory, 'PostgreSQL restore-drill lease adapter is missing').toBeTypeOf('function');
    if (factory === undefined) {
      throw new Error('PostgreSQL restore-drill lease adapter is missing');
    }

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
    const lease = factory({ reserve: () => Promise.resolve(session) });

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
    const factory = (
      backupScript as unknown as {
        readonly createPostgresRestoreDrillLease?: CreatePostgresRestoreDrillLease;
      }
    ).createPostgresRestoreDrillLease;
    expect(factory).toBeTypeOf('function');
    if (factory === undefined) {
      throw new Error('PostgreSQL restore-drill lease adapter is missing');
    }

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
    const lease = factory({ reserve: () => Promise.resolve(session) });

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
