import { Readable } from 'node:stream';

import { internalRepoRef, newId } from '@zapp/contracts';
import { describe, expect, it } from 'vitest';

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
  readonly targetRef: string;
  readonly target: CreatedRestoreTarget;
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
  readonly close: () => Promise<void>;
}) => backupScript.BackupCliOperations;

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
        body: { clone_url: 'https://git.test/drill/repository.git', empty: true },
      },
    });
    const first = await prepare(store, forgejo);
    const createCall = forgejo.calls.find((call) => call.path.endsWith('/repos'));
    const description = (createCall?.body as { readonly description?: unknown } | undefined)
      ?.description;
    expect(description).toEqual(expect.any(String));
    expect(store.values.has(first.markerKey)).toBe(true);
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);

    // Process exit here: the first target handle is deliberately discarded.
    const [owner, name] = first.targetRef.split('/') as [string, string];
    forgejo.route(`GET /repos/${owner}/${name}`, {
      status: 200,
      body: { clone_url: `https://git.test/${first.targetRef}.git`, empty: false, description },
      then: { status: 404 },
    });
    forgejo.route(`POST /orgs/${owner}/repos`, {
      status: 201,
      body: { clone_url: `https://git.test/${first.targetRef}.git`, empty: true, description },
    });
    forgejo.route(`DELETE /repos/${owner}/${name}`, { status: 204 });

    const retry = await prepare(store, forgejo);
    expect(retry.markerKey).toBe(first.markerKey);
    expect(retry.targetRef).toBe(first.targetRef);
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);

    await retry.target.compensate();
    await retry.clearMarker();

    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toHaveLength(2);
    expect(store.deletes).toEqual([first.markerKey]);
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
        clone_url: 'https://git.test/pre-existing/repository.git',
        empty: true,
        description: 'operator-owned repository',
      },
    });

    await expect(prepare(store, forgejo)).rejects.toThrow(
      'restore drill target is not marker-owned',
    );
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(store.values.size).toBe(1);
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
        body: { clone_url: 'https://git.test/drill/repository.git', empty: true },
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
      close: () => Promise.resolve(),
    });

    await expect(operations.restoreDrill()).resolves.toMatchObject({
      status: 'restore-drill-verified',
      checkedBranches: 1,
    });
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
    expect(store.deletes).toHaveLength(1);
    expect(store.deletes[0]).toContain('/git-restore-drills/quarterly-v1.json');
    expect([...store.values.keys()]).toEqual([backupKey]);
  });
});
