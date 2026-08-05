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
} from '../src/backup.js';
import type { ForgejoClient, ForgejoRequest, ForgejoResponse } from '../src/forgejo/client.js';
import { createFakeForgejo } from './support/fake-forgejo.js';

const ORGANIZATION_ID = newId('org');
const PROJECT_ID = newId('proj');
const SOURCE: BackupRepository = {
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  internalRepoRef: internalRepoRef({ organizationId: ORGANIZATION_ID, projectId: PROJECT_ID }),
  cloneUrl: 'https://git.test/source/repository.git',
  defaultBranch: 'main',
};
const BACKUP_KEY = `org/${ORGANIZATION_ID}/project/${PROJECT_ID}/git-backups/2026-08-04.bundle`;

class ReceiptStore implements BackupObjectStore {
  readonly values = new Map<string, Buffer>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  failNextPutMatching: RegExp | undefined;

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.values.has(key));
  }

  async put(key: string, source: BackupUploadSource): Promise<BackupPutResult> {
    this.puts.push(key);
    if (this.failNextPutMatching?.test(key)) {
      this.failNextPutMatching = undefined;
      throw new Error('synthetic receipt write failure');
    }
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
      ? Promise.reject(new Error('receipt missing'))
      : Promise.resolve(Readable.from(value));
  }

  list(prefix: string): Promise<{ readonly objects: readonly BackupObject[] }> {
    return Promise.resolve({
      objects: [...this.values.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, lastModified: new Date('2026-08-04T09:30:00Z') })),
    });
  }

  delete(key: string): Promise<void> {
    this.deletes.push(key);
    return Promise.reject(new Error('restore receipts are append-only'));
  }
}

class RestoreGit implements BackupGit {
  readonly phases: string[] = [];
  failPushes = 0;

  createBundle(): Promise<void> {
    return Promise.reject(new Error('not used by restore'));
  }

  verifyBundle(): Promise<void> {
    this.phases.push('bundle-verified');
    return Promise.resolve();
  }

  mirrorPush(): Promise<void> {
    this.phases.push('mirror-pushed');
    if (this.failPushes > 0) {
      this.failPushes -= 1;
      return Promise.reject(new Error('synthetic process loss during push'));
    }
    return Promise.resolve();
  }

  remoteRefs(): Promise<ReadonlyMap<string, string>> {
    this.phases.push('refs-read');
    return Promise.resolve(new Map([['refs/heads/main', 'a'.repeat(40)]]));
  }
}

class StatefulForgejo implements ForgejoClient {
  readonly baseUrl = 'https://git.test';
  readonly calls: ForgejoRequest[] = [];
  repository:
    | {
        readonly id: number;
        readonly clone_url: string;
        readonly description: string;
        readonly empty: boolean;
      }
    | undefined;

  send<T>(request: ForgejoRequest): Promise<ForgejoResponse<T>> {
    this.calls.push(request);
    if (request.method === 'GET' && request.path.startsWith('/orgs/')) {
      return Promise.resolve({ status: 200, body: { username: 'organization' } as T });
    }
    if (request.method === 'GET' && request.path.startsWith('/repos/')) {
      return Promise.resolve(
        this.repository === undefined
          ? { status: 404, body: undefined }
          : { status: 200, body: this.repository as T },
      );
    }
    if (request.method === 'POST' && request.path.endsWith('/repos')) {
      const body = request.body as { readonly description?: unknown };
      this.repository = {
        id: 501,
        clone_url: 'https://git.test/restore/repository.git',
        description: String(body.description),
        empty: true,
      };
      return Promise.resolve({ status: 201, body: this.repository as T });
    }
    if (request.method === 'DELETE') {
      return Promise.reject(new Error('repository deletion is forbidden'));
    }
    return Promise.resolve({ status: 201, body: {} as T });
  }
}

interface RestoreOperation {
  readonly intentKey: string;
  readonly targetRef: string;
  resolveTarget(): Promise<{ readonly repositoryId: number; readonly cloneUrl: string }>;
  recordPhase(
    phase: 'push-started' | 'push-complete' | 'verified',
    result?: {
      readonly checkedBranches: number;
      readonly branches: readonly unknown[];
      readonly refs: readonly unknown[];
    },
  ): Promise<void>;
}

type BeginRestoreOperation = (
  deps: {
    readonly store: BackupObjectStore;
    readonly client: ForgejoClient;
  },
  input: {
    readonly kind: 'manual' | 'drill';
    readonly idempotencyKey: string;
    readonly source: BackupRepository;
    readonly backupKey: string;
  },
) => Promise<RestoreOperation>;

function beginRestoreOperation(): BeginRestoreOperation | undefined {
  return (backupScript as { readonly beginRestoreOperation?: BeginRestoreOperation })
    .beginRestoreOperation;
}

describe('intent-first restore recovery', () => {
  it('rejects a source-mismatched backup selector before writing intent state', async () => {
    const begin = beginRestoreOperation();
    expect(begin).toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const forgejo = new StatefulForgejo();

    await expect(
      begin(
        { store, client: forgejo },
        {
          kind: 'manual',
          idempotencyKey: 'incident-2026-08-04-wrong-source',
          source: SOURCE,
          backupKey: BACKUP_KEY.replace(PROJECT_ID, newId('proj')),
        },
      ),
    ).rejects.toThrow('Invalid restore operation');
    expect(store.puts).toEqual([]);
    expect(forgejo.calls).toEqual([]);
  });

  it('does not touch Forgejo when the intent receipt cannot be persisted', async () => {
    const begin = beginRestoreOperation();
    expect(begin).toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    store.failNextPutMatching = /git-restore-intents\/manual\/.*\.json$/;
    const forgejo = new StatefulForgejo();

    await expect(
      begin(
        { store, client: forgejo },
        {
          kind: 'manual',
          idempotencyKey: 'incident-2026-08-04-intent-write',
          source: SOURCE,
          backupKey: BACKUP_KEY,
        },
      ),
    ).rejects.toThrow('synthetic receipt write failure');
    expect(forgejo.calls).toEqual([]);
    expect(store.values.size).toBe(0);
  });

  it('durably persists intent before any Forgejo repository creation', async () => {
    const begin = beginRestoreOperation();
    expect(begin, 'intent-first restore operation is missing').toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const forgejo = createFakeForgejo();

    const operation = await begin(
      { store, client: forgejo },
      {
        kind: 'manual',
        idempotencyKey: 'incident-2026-08-04-primary',
        source: SOURCE,
        backupKey: BACKUP_KEY,
      },
    );

    expect(operation.intentKey).toMatch(/git-restore-intents\/manual\/[0-9a-f]{64}\.json$/);
    expect(store.puts).toEqual([operation.intentKey]);
    expect(store.values.get(operation.intentKey)?.toString('utf8')).toContain(BACKUP_KEY);
    expect(forgejo.writes).toEqual([]);
  });

  it('adopts a marker-matching target created before its immutable-id receipt was saved', async () => {
    const begin = beginRestoreOperation();
    expect(begin, 'intent-first restore operation is missing').toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const forgejo = createFakeForgejo();
    const operation = await begin(
      { store, client: forgejo },
      {
        kind: 'manual',
        idempotencyKey: 'incident-2026-08-04-adopt',
        source: SOURCE,
        backupKey: BACKUP_KEY,
      },
    );
    const intent = JSON.parse(store.values.get(operation.intentKey)?.toString('utf8') ?? '{}') as {
      readonly targetMarker?: unknown;
    };
    const [owner, name] = operation.targetRef.split('/') as [string, string];
    forgejo.route(`GET /orgs/${owner}`, { status: 200, body: { username: owner } });
    forgejo.route(`GET /repos/${owner}/${name}`, {
      status: 200,
      body: {
        id: 418,
        clone_url: `https://git.test/${operation.targetRef}.git`,
        description: intent.targetMarker,
        empty: true,
      },
    });

    await expect(operation.resolveTarget()).resolves.toMatchObject({ repositoryId: 418 });

    expect(forgejo.writes).toEqual([]);
    expect(store.puts).toHaveLength(2);
    expect(store.puts[1]).toMatch(/\.target\.json$/);
  });

  it('persists append-only push and verification phase receipts for crash recovery', async () => {
    const begin = beginRestoreOperation();
    expect(begin, 'intent-first restore operation is missing').toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const forgejo = createFakeForgejo();
    const operation = await begin(
      { store, client: forgejo },
      {
        kind: 'manual',
        idempotencyKey: 'incident-2026-08-04-phases',
        source: SOURCE,
        backupKey: BACKUP_KEY,
      },
    );
    const intent = JSON.parse(store.values.get(operation.intentKey)?.toString('utf8') ?? '{}') as {
      readonly targetMarker?: unknown;
    };
    const [owner, name] = operation.targetRef.split('/') as [string, string];
    forgejo.route(`GET /orgs/${owner}`, { status: 200, body: { username: owner } });
    forgejo.route(`GET /repos/${owner}/${name}`, {
      status: 200,
      body: {
        id: 419,
        clone_url: `https://git.test/${operation.targetRef}.git`,
        description: intent.targetMarker,
        empty: false,
      },
    });
    await operation.resolveTarget();

    await operation.recordPhase('push-started');
    await operation.recordPhase('push-complete');
    await operation.recordPhase('verified', {
      checkedBranches: 1,
      branches: [{ name: 'main', expectedSha: 'a'.repeat(40), actualSha: 'a'.repeat(40) }],
      refs: [{ name: 'refs/heads/main', sha: 'a'.repeat(40) }],
    });

    expect(store.puts.slice(2)).toEqual([
      expect.stringMatching(/\.push-started\.json$/),
      expect.stringMatching(/\.push-complete\.json$/),
      expect.stringMatching(/\.verified\.json$/),
    ]);
  });

  it('runs manual restore through the durable intent and phase-receipt callsite', async () => {
    const store = new ReceiptStore();
    store.values.set(BACKUP_KEY, Buffer.from('bundle bytes'));
    const git = new RestoreGit();
    const forgejo = new StatefulForgejo();
    const inventory: BackupInventory = {
      listProvisionedRepositories: () => Promise.resolve([SOURCE]),
      expectedBranches: () => Promise.resolve([{ name: 'main', headCommitSha: 'a'.repeat(40) }]),
    };
    const operations = backupScript.createBackupOperations({
      inventory,
      store,
      git,
      client: forgejo,
      restoreDrillLease: { runExclusive: async (operation) => await operation() },
      close: () => Promise.resolve(),
    });

    await expect(
      operations.restore({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        key: BACKUP_KEY,
        idempotencyKey: 'incident-2026-08-04-callsite',
      }),
    ).resolves.toMatchObject({ status: 'restored', checkedBranches: 1 });

    expect([...store.values.keys()]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/git-restore-intents\/manual\/[0-9a-f]{64}\.json$/),
        expect.stringMatching(/\.target\.json$/),
        expect.stringMatching(/\.push-started\.json$/),
        expect.stringMatching(/\.push-complete\.json$/),
        expect.stringMatching(/\.verified\.json$/),
      ]),
    );
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('reuses one persistent marker-owned drill target without path deletion', async () => {
    const store = new ReceiptStore();
    store.values.set(BACKUP_KEY, Buffer.from('bundle bytes'));
    const forgejo = new StatefulForgejo();
    const operations = backupScript.createBackupOperations({
      inventory: {
        listProvisionedRepositories: () => Promise.resolve([SOURCE]),
        expectedBranches: () => Promise.resolve([{ name: 'main', headCommitSha: 'a'.repeat(40) }]),
      },
      store,
      git: new RestoreGit(),
      client: forgejo,
      restoreDrillLease: { runExclusive: async (operation) => await operation() },
      close: () => Promise.resolve(),
    });

    await expect(operations.restoreDrill()).resolves.toMatchObject({
      status: 'restore-drill-verified',
    });
    store.values.set(
      `org/${ORGANIZATION_ID}/project/${PROJECT_ID}/git-backups/2026-08-05.bundle`,
      Buffer.from('newer bundle bytes'),
    );
    await expect(operations.restoreDrill()).resolves.toMatchObject({
      status: 'restore-drill-verified',
    });

    expect(
      forgejo.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/repos')),
    ).toHaveLength(1);
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('leaves a created target intact when its immutable-id receipt write fails, then adopts it', async () => {
    const begin = beginRestoreOperation();
    expect(begin).toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const forgejo = new StatefulForgejo();
    const input = {
      kind: 'manual' as const,
      idempotencyKey: 'incident-2026-08-04-receipt-loss',
      source: SOURCE,
      backupKey: BACKUP_KEY,
    };
    const first = await begin({ store, client: forgejo }, input);
    store.failNextPutMatching = /\.target\.json$/;

    await expect(first.resolveTarget()).rejects.toThrow('synthetic receipt write failure');
    expect(forgejo.repository?.id).toBe(501);
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);

    const retry = await begin({ store, client: forgejo }, input);
    await expect(retry.resolveTarget()).resolves.toMatchObject({ repositoryId: 501 });
    expect(
      forgejo.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/repos')),
    ).toHaveLength(1);
    expect(store.deletes).toEqual([]);
  });

  it('resumes an intent-only receipt after process loss before repository creation', async () => {
    const begin = beginRestoreOperation();
    expect(begin).toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const forgejo = new StatefulForgejo();
    const input = {
      kind: 'manual' as const,
      idempotencyKey: 'incident-2026-08-04-before-create',
      source: SOURCE,
      backupKey: BACKUP_KEY,
    };
    await begin({ store, client: forgejo }, input);
    expect(forgejo.calls).toEqual([]);

    const retry = await begin({ store, client: forgejo }, input);
    await expect(retry.resolveTarget()).resolves.toMatchObject({ repositoryId: 501 });
    expect(
      forgejo.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/repos')),
    ).toHaveLength(1);
  });

  it('adopts only the marker-matching winner of a GET/POST 409 race', async () => {
    const begin = beginRestoreOperation();
    expect(begin).toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const forgejo = createFakeForgejo();
    const operation = await begin(
      { store, client: forgejo },
      {
        kind: 'manual',
        idempotencyKey: 'incident-2026-08-04-create-race',
        source: SOURCE,
        backupKey: BACKUP_KEY,
      },
    );
    const intent = JSON.parse(store.values.get(operation.intentKey)?.toString('utf8') ?? '{}') as {
      readonly targetMarker?: unknown;
    };
    const [owner, name] = operation.targetRef.split('/') as [string, string];
    forgejo.route(`GET /orgs/${owner}`, { status: 200, body: { username: owner } });
    forgejo.route(`GET /repos/${owner}/${name}`, {
      status: 404,
      then: {
        status: 200,
        body: {
          id: 610,
          clone_url: `https://git.test/${operation.targetRef}.git`,
          description: intent.targetMarker,
          empty: true,
        },
      },
    });
    forgejo.route(`POST /orgs/${owner}/repos`, { status: 409 });

    await expect(operation.resolveTarget()).resolves.toMatchObject({ repositoryId: 610 });
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('preserves a concurrent replacement installed after the target receipt write', async () => {
    const begin = beginRestoreOperation();
    expect(begin).toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const forgejo = createFakeForgejo();
    const operation = await begin(
      { store, client: forgejo },
      {
        kind: 'manual',
        idempotencyKey: 'incident-2026-08-04-final-read-race',
        source: SOURCE,
        backupKey: BACKUP_KEY,
      },
    );
    const intent = JSON.parse(store.values.get(operation.intentKey)?.toString('utf8') ?? '{}') as {
      readonly targetMarker?: unknown;
    };
    const [owner, name] = operation.targetRef.split('/') as [string, string];
    forgejo.route(`GET /orgs/${owner}`, { status: 200, body: { username: owner } });
    forgejo.route(`GET /repos/${owner}/${name}`, {
      status: 404,
      then: {
        status: 200,
        body: {
          id: 999,
          clone_url: `https://git.test/${operation.targetRef}.git`,
          description: intent.targetMarker,
          empty: true,
        },
      },
    });
    forgejo.route(`POST /orgs/${owner}/repos`, {
      status: 201,
      body: {
        id: 611,
        clone_url: `https://git.test/${operation.targetRef}.git`,
        description: intent.targetMarker,
        empty: true,
      },
    });

    await expect(operation.resolveTarget()).rejects.toThrow('ownership was lost');
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('refuses a marker mismatch without creating or deleting a repository', async () => {
    const begin = beginRestoreOperation();
    expect(begin).toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const forgejo = new StatefulForgejo();
    forgejo.repository = {
      id: 700,
      clone_url: 'https://git.test/preexisting/repository.git',
      description: 'another restore operation',
      empty: true,
    };
    const operation = await begin(
      { store, client: forgejo },
      {
        kind: 'manual',
        idempotencyKey: 'incident-2026-08-04-marker-mismatch',
        source: SOURCE,
        backupKey: BACKUP_KEY,
      },
    );

    await expect(operation.resolveTarget()).rejects.toThrow('does not match the durable intent');
    expect(forgejo.calls.filter((call) => call.method === 'POST')).toEqual([]);
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('refuses a replacement whose immutable id differs from the durable target receipt', async () => {
    const begin = beginRestoreOperation();
    expect(begin).toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const forgejo = new StatefulForgejo();
    const input = {
      kind: 'manual' as const,
      idempotencyKey: 'incident-2026-08-04-replacement',
      source: SOURCE,
      backupKey: BACKUP_KEY,
    };
    const first = await begin({ store, client: forgejo }, input);
    const original = await first.resolveTarget();
    forgejo.repository = {
      id: 999,
      clone_url: 'https://git.test/replacement/repository.git',
      description: forgejo.repository?.description ?? '',
      empty: true,
    };

    const retry = await begin({ store, client: forgejo }, input);
    await expect(retry.resolveTarget()).rejects.toThrow('ownership was lost');
    expect(original.repositoryId).toBe(501);
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('conflicts when one manual idempotency key is reused with a different selector', async () => {
    const begin = beginRestoreOperation();
    expect(begin).toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const forgejo = new StatefulForgejo();
    const idempotencyKey = 'incident-2026-08-04-selector-conflict';
    await begin(
      { store, client: forgejo },
      { kind: 'manual', idempotencyKey, source: SOURCE, backupKey: BACKUP_KEY },
    );

    await expect(
      begin(
        { store, client: forgejo },
        {
          kind: 'manual',
          idempotencyKey,
          source: SOURCE,
          backupKey: BACKUP_KEY.replace('2026-08-04', '2026-08-03'),
        },
      ),
    ).rejects.toThrow('idempotency key conflicts');
    expect(forgejo.calls).toEqual([]);
  });

  it('resumes after process loss during mirror push using the same intent and target', async () => {
    const store = new ReceiptStore();
    store.values.set(BACKUP_KEY, Buffer.from('bundle bytes'));
    const git = new RestoreGit();
    git.failPushes = 1;
    const forgejo = new StatefulForgejo();
    const operations = backupScript.createBackupOperations({
      inventory: {
        listProvisionedRepositories: () => Promise.resolve([SOURCE]),
        expectedBranches: () => Promise.resolve([{ name: 'main', headCommitSha: 'a'.repeat(40) }]),
      },
      store,
      git,
      client: forgejo,
      restoreDrillLease: { runExclusive: async (operation) => await operation() },
      close: () => Promise.resolve(),
    });
    const selector = {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      key: BACKUP_KEY,
      idempotencyKey: 'incident-2026-08-04-push-loss',
    };

    await expect(operations.restore(selector)).rejects.toThrow('Bundle mirror push failed');
    expect([...store.values.keys()]).toEqual(
      expect.arrayContaining([expect.stringMatching(/\.push-started\.json$/)]),
    );
    expect([...store.values.keys()].some((key) => key.endsWith('.push-complete.json'))).toBe(false);

    await expect(operations.restore(selector)).resolves.toMatchObject({ status: 'restored' });
    expect(
      forgejo.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/repos')),
    ).toHaveLength(1);
    expect(store.deletes).toEqual([]);
  });

  it('resumes after verified-state receipt loss without replacing or deleting the target', async () => {
    const store = new ReceiptStore();
    store.values.set(BACKUP_KEY, Buffer.from('bundle bytes'));
    store.failNextPutMatching = /\.verified\.json$/;
    const forgejo = new StatefulForgejo();
    const operations = backupScript.createBackupOperations({
      inventory: {
        listProvisionedRepositories: () => Promise.resolve([SOURCE]),
        expectedBranches: () => Promise.resolve([{ name: 'main', headCommitSha: 'a'.repeat(40) }]),
      },
      store,
      git: new RestoreGit(),
      client: forgejo,
      restoreDrillLease: { runExclusive: async (operation) => await operation() },
      close: () => Promise.resolve(),
    });
    const selector = {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      key: BACKUP_KEY,
      idempotencyKey: 'incident-2026-08-04-verified-loss',
    };

    await expect(operations.restore(selector)).rejects.toThrow('synthetic receipt write failure');
    await expect(operations.restore(selector)).resolves.toMatchObject({ status: 'restored' });
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(
      forgejo.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/repos')),
    ).toHaveLength(1);
  });
});
