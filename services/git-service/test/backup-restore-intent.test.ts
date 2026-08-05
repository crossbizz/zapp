import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { internalRepoRef, newId } from '@zapp/contracts';
import { describe, expect, it } from 'vitest';

import * as backupScript from '../scripts/backup.js';
import { createRecordingGitAuditSink } from '../src/audit.js';
import type {
  BackupGit,
  BackupInventory,
  BackupObject,
  BackupObjectStore,
  BackupPutResult,
  BackupRepository,
  BackupUploadSource,
  RestoreRemoteGit,
} from '../src/backup.js';
import type { ForgejoClient, ForgejoRequest, ForgejoResponse } from '../src/forgejo/client.js';
import { createTokenService } from '../src/tokens.js';
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
  private nextPutPause:
    | {
        readonly pattern: RegExp;
        readonly reached: () => void;
        readonly resume: Promise<void>;
      }
    | undefined;
  private nextListPause:
    | {
        readonly captured: () => void;
        readonly resume: Promise<void>;
      }
    | undefined;

  pauseNextPutBeforeWrite(
    pattern: RegExp,
  ): { readonly reached: Promise<void>; readonly resume: () => void } {
    let signalReached: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      signalReached = resolve;
    });
    let resume: (() => void) | undefined;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    this.nextPutPause = {
      pattern,
      reached: () => {
        signalReached?.();
      },
      resume: resumed,
    };
    return {
      reached,
      resume: () => {
        resume?.();
      },
    };
  }

  pauseNextList(): { readonly captured: Promise<void>; readonly resume: () => void } {
    let signalCaptured: (() => void) | undefined;
    const captured = new Promise<void>((resolve) => {
      signalCaptured = resolve;
    });
    let resume: (() => void) | undefined;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    this.nextListPause = {
      captured: () => {
        signalCaptured?.();
      },
      resume: resumed,
    };
    return {
      captured,
      resume: () => {
        resume?.();
      },
    };
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.values.has(key));
  }

  async put(key: string, source: BackupUploadSource): Promise<BackupPutResult> {
    this.puts.push(key);
    const pause = this.nextPutPause;
    if (pause !== undefined && pause.pattern.test(key)) {
      this.nextPutPause = undefined;
      pause.reached();
      await pause.resume;
    }
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

  async list(prefix: string): Promise<{ readonly objects: readonly BackupObject[] }> {
    const result = {
      objects: [...this.values.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, lastModified: new Date('2026-08-04T09:30:00Z') })),
    };
    const pause = this.nextListPause;
    if (pause !== undefined) {
      this.nextListPause = undefined;
      pause.captured();
      await pause.resume;
    }
    return result;
  }

  delete(key: string): Promise<void> {
    this.deletes.push(key);
    return Promise.reject(new Error('restore receipts are append-only'));
  }
}

class RestoreGit implements BackupGit {
  readonly phases: string[] = [];
  readonly refs = new Map([['refs/heads/main', 'a'.repeat(40)]]);
  failPushes = 0;

  createBundle(): Promise<void> {
    return Promise.reject(new Error('not used by restore'));
  }

  verifyBundle(bundlePath: string): Promise<void> {
    void bundlePath;
    this.phases.push('bundle-verified');
    return Promise.resolve();
  }

  backupRepresentation(bundlePath: string): Promise<'bundle' | 'empty'> {
    void bundlePath;
    return Promise.resolve('bundle');
  }

  prepareRestore(_bundlePath: string, mirrorPath: string) {
    this.phases.push('mirror-prepared');
    return Promise.resolve({ kind: 'bundle' as const, mirrorPath });
  }

  pushMirror(): Promise<void> {
    this.phases.push('mirror-pushed');
    if (this.failPushes > 0) {
      this.failPushes -= 1;
      return Promise.reject(new Error('synthetic process loss during push'));
    }
    return Promise.resolve();
  }

  remoteRefs(targetCloneUrl: string, deadlineAt: Date): Promise<ReadonlyMap<string, string>> {
    void targetCloneUrl;
    void deadlineAt;
    this.phases.push('refs-read');
    return Promise.resolve(new Map(this.refs));
  }
}

class CandidateRestoreGit extends RestoreGit {
  readonly verifiedBodies: string[] = [];

  async backupRepresentation(bundlePath: string) {
    return (await readFile(bundlePath, 'utf8')) === 'empty backup bytes'
      ? ('empty' as const)
      : ('bundle' as const);
  }

  override async verifyBundle(bundlePath: string): Promise<void> {
    const body = await readFile(bundlePath, 'utf8');
    this.verifiedBodies.push(body);
    if (body === 'corrupt bundle') {
      throw new Error('corrupt bundle');
    }
    await super.verifyBundle(bundlePath);
  }
}

function credentialWindow() {
  const issuedAt = Date.now();
  return {
    expiresAt: new Date(issuedAt + 300_000),
    deadlineAt: new Date(issuedAt + 240_000),
  };
}

function credentialsFor(git: RestoreRemoteGit) {
  return {
    issue: (input: { readonly cloneUrl: string }) => {
      return Promise.resolve({
        cloneUrl: input.cloneUrl,
        git,
        ...credentialWindow(),
        release: () => Promise.resolve(),
      });
    },
  };
}

class StatefulForgejo implements ForgejoClient {
  readonly baseUrl = 'https://git.test';
  readonly calls: ForgejoRequest[] = [];
  deleteUser: ((username: string) => Promise<void>) | undefined;
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
    if (request.method === 'DELETE' && request.path.startsWith('/admin/users/')) {
      const username = decodeURIComponent(
        request.path.slice('/admin/users/'.length).replace(/\?purge=true$/, ''),
      );
      return (this.deleteUser?.(username) ?? Promise.resolve()).then(() => ({
        status: 204,
        body: undefined,
      }));
    }
    if (request.method === 'DELETE') {
      return Promise.reject(new Error('repository deletion is forbidden'));
    }
    return Promise.resolve({ status: 201, body: {} as T });
  }
}

interface RestoreCredentialAllocation {
  readonly version: 1;
  readonly intentKey: string;
  readonly operationId: string;
  readonly targetRef: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly username: string;
  readonly expiresAt: string;
}

interface RestoreOperation {
  readonly intentKey: string;
  readonly targetRef: string;
  readonly completedResult?: {
    readonly checkedBranches: number;
    readonly branches: readonly unknown[];
    readonly refs: readonly unknown[];
  };
  resolveTarget(): Promise<{ readonly repositoryId: number; readonly cloneUrl: string }>;
  reserveCredentialCleanup(identity: {
    readonly username: string;
    readonly expiresAt: Date;
  }): Promise<RestoreCredentialAllocation>;
  recordCredentialCreated(allocation: RestoreCredentialAllocation): Promise<void>;
  completeCredentialCleanup(allocation: RestoreCredentialAllocation): Promise<void>;
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
    readonly now?: () => Date;
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

  it('refuses a marker-matching target without an immutable-id receipt', async () => {
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

    await expect(operation.resolveTarget()).rejects.toThrow(
      'Restore target has no immutable repository receipt; repository preserved',
    );

    expect(forgejo.writes).toEqual([]);
    expect(store.puts).toEqual([operation.intentKey]);
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
      readonly operationId?: unknown;
      readonly targetMarker?: unknown;
    };
    const [owner, name] = operation.targetRef.split('/') as [string, string];
    forgejo.route(`GET /orgs/${owner}`, { status: 200, body: { username: owner } });
    forgejo.route(`GET /repos/${owner}/${name}`, {
      status: 404,
      then: {
        status: 200,
        body: {
          id: 419,
          clone_url: `https://git.test/${operation.targetRef}.git`,
          description: intent.targetMarker,
          empty: true,
        },
      },
    });
    forgejo.route(`POST /orgs/${owner}/repos`, {
      status: 201,
      body: {
        id: 419,
        clone_url: `https://git.test/${operation.targetRef}.git`,
        description: intent.targetMarker,
        empty: true,
      },
    });
    await operation.resolveTarget();

    await operation.recordPhase('push-started');
    await operation.recordPhase('push-complete');
    const result = {
      checkedBranches: 1,
      branches: [{ name: 'main', expectedSha: 'a'.repeat(40), actualSha: 'a'.repeat(40) }],
      refs: [{ name: 'refs/heads/main', sha: 'a'.repeat(40) }],
    };
    await operation.recordPhase('verified', result);

    expect(store.puts.slice(2)).toEqual([
      expect.stringMatching(/\.push-started\.json$/),
      expect.stringMatching(/\.push-complete\.json$/),
      expect.stringMatching(/\.verification-fence\.json$/),
      expect.stringMatching(/\.verified\.json$/),
    ]);
    const fenceBody = [...store.values]
      .find(([key]) => key.endsWith('.verification-fence.json'))?.[1]
      .toString('utf8');
    const fence = JSON.parse(fenceBody ?? '{}') as {
      readonly resultDigest?: unknown;
    };
    expect(fence).toMatchObject({
      version: 1,
      intentKey: operation.intentKey,
      operationId: intent.operationId,
      backupKey: BACKUP_KEY,
      targetRef: operation.targetRef,
      repositoryId: 419,
      result,
    });
    expect(fence.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(fenceBody).not.toMatch(/token|password/i);
  });

  it('runs manual restore through the durable intent and phase-receipt callsite', async () => {
    const store = new ReceiptStore();
    store.values.set(BACKUP_KEY, Buffer.from('bundle bytes'));
    const backupGit = new RestoreGit();
    const restoreGit = new RestoreGit();
    const boundGit = new RestoreGit();
    const forgejo = new StatefulForgejo();
    const inventory: BackupInventory = {
      listProvisionedRepositories: () => Promise.resolve([SOURCE]),
      expectedBranches: () => Promise.resolve([{ name: 'main', headCommitSha: 'a'.repeat(40) }]),
    };
    const dependencies: Parameters<typeof backupScript.createBackupOperations>[0] = {
      inventory,
      store,
      git: backupGit,
      restoreGit,
      client: forgejo,
      restoreCredentials: credentialsFor(boundGit),
      restoreDrillLease: { runExclusive: async (operation) => await operation() },
      close: () => Promise.resolve(),
    };
    const operations = backupScript.createBackupOperations(dependencies);

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
    expect(backupGit.phases).toEqual([]);
    expect(restoreGit.phases).toEqual(['bundle-verified', 'mirror-prepared']);
    expect(boundGit.phases).toEqual(['mirror-pushed', 'refs-read']);
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('returns the immutable verified result on completed manual replay without touching newer refs', async () => {
    const store = new ReceiptStore();
    store.values.set(BACKUP_KEY, Buffer.from('bundle bytes'));
    const restoreGit = new RestoreGit();
    const boundGit = new RestoreGit();
    const forgejo = new StatefulForgejo();
    let issuedCredentials = 0;
    const operations = backupScript.createBackupOperations({
      inventory: {
        listProvisionedRepositories: () => Promise.resolve([SOURCE]),
        expectedBranches: () => Promise.resolve([{ name: 'main', headCommitSha: 'a'.repeat(40) }]),
      },
      store,
      git: restoreGit,
      restoreGit,
      client: forgejo,
      restoreCredentials: {
        issue: (input) => {
          issuedCredentials += 1;
          return Promise.resolve({
            cloneUrl: input.cloneUrl,
            git: boundGit,
            ...credentialWindow(),
            release: () => Promise.resolve(),
          });
        },
      },
      restoreDrillLease: { runExclusive: async (operation) => await operation() },
      close: () => Promise.resolve(),
    });
    const selector = {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      key: BACKUP_KEY,
      idempotencyKey: 'incident-2026-08-04-completed-replay',
    };
    const first = await operations.restore(selector);
    const restorePhases = [...restoreGit.phases];
    const boundPhases = [...boundGit.phases];

    boundGit.refs.set('refs/heads/main', 'b'.repeat(40));
    boundGit.refs.set('refs/heads/newer', 'c'.repeat(40));

    await expect(operations.restore(selector)).resolves.toEqual(first);
    expect(restoreGit.phases).toEqual(restorePhases);
    expect(boundGit.phases).toEqual(boundPhases);
    expect(boundGit.refs).toEqual(
      new Map([
        ['refs/heads/main', 'b'.repeat(40)],
        ['refs/heads/newer', 'c'.repeat(40)],
      ]),
    );
    expect(issuedCredentials).toBe(1);
  });

  it('does not complete until restricted credential revocation succeeds on replay', async () => {
    const store = new ReceiptStore();
    store.values.set(BACKUP_KEY, Buffer.from('bundle bytes'));
    const restoreGit = new RestoreGit();
    const boundGit = new RestoreGit();
    const forgejo = new StatefulForgejo();
    let issuedCredentials = 0;
    const releaseAttempts: number[] = [];
    const activeCredentials = new Set<string>();
    const cleanupDeletes: string[] = [];
    forgejo.deleteUser = (username) => {
      cleanupDeletes.push(username);
      activeCredentials.delete(username);
      return Promise.resolve();
    };
    const operations = backupScript.createBackupOperations({
      inventory: {
        listProvisionedRepositories: () => Promise.resolve([SOURCE]),
        expectedBranches: () => Promise.resolve([{ name: 'main', headCommitSha: 'a'.repeat(40) }]),
      },
      store,
      git: restoreGit,
      restoreGit,
      client: forgejo,
      restoreCredentials: {
        issue: async (input) => {
          issuedCredentials += 1;
          const issueNumber = issuedCredentials;
          const username = `zt-190000000${String(issueNumber)}-00000000000${String(issueNumber)}`;
          const window = credentialWindow();
          const allocation = await input.reserveCredentialCleanup({
            username,
            expiresAt: window.expiresAt,
          });
          activeCredentials.add(username);
          await input.recordCredentialCreated(allocation);
          return {
            cloneUrl: input.cloneUrl,
            git: boundGit,
            ...window,
            release: async () => {
              releaseAttempts.push(issueNumber);
              if (issueNumber === 1) {
                throw new Error('synthetic revocation failure');
              }
              activeCredentials.delete(username);
              await input.completeCredentialCleanup(allocation);
            },
          };
        },
      },
      restoreDrillLease: { runExclusive: async (operation) => await operation() },
      close: () => Promise.resolve(),
    });
    const selector = {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      key: BACKUP_KEY,
      idempotencyKey: 'incident-2026-08-04-revocation-replay',
    };

    await expect(operations.restore(selector)).rejects.toThrow('synthetic revocation failure');
    const completedAfterFailure = [...store.values.keys()].some((key) =>
      key.endsWith('.verified.json'),
    );
    await expect(operations.restore(selector)).resolves.toMatchObject({ status: 'restored' });

    expect(issuedCredentials).toBe(2);
    expect(releaseAttempts).toEqual([1, 1, 2]);
    expect(activeCredentials).toEqual(new Set());
    expect(cleanupDeletes).toEqual(['zt-1900000001-000000000001']);
    const cleanupReceipts = [...store.values]
      .filter(([key]) => key.includes('.credentials/'))
      .map(([key, value]) => ({ key, body: JSON.parse(value.toString('utf8')) as object }));
    expect(cleanupReceipts.map(({ key }) => key)).toEqual([
      expect.stringMatching(/00000001\.allocated\.json$/),
      expect.stringMatching(/00000001\.created\.json$/),
      expect.stringMatching(/00000001\.released\.json$/),
      expect.stringMatching(/00000002\.allocated\.json$/),
      expect.stringMatching(/00000002\.created\.json$/),
      expect.stringMatching(/00000002\.released\.json$/),
    ]);
    expect(JSON.stringify(cleanupReceipts)).not.toMatch(/token|password/i);
    expect(completedAfterFailure).toBe(false);
  });

  it('rejects a credential allocation added after verification cleanup snapshots receipts', async () => {
    const begin = beginRestoreOperation();
    expect(begin).toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const forgejo = new StatefulForgejo();
    const now = new Date('2026-08-04T10:00:00.000Z');
    const input = {
      kind: 'manual' as const,
      idempotencyKey: 'incident-2026-08-04-verification-allocation-race',
      source: SOURCE,
      backupKey: BACKUP_KEY,
    };
    const operationDeps = { store, client: forgejo, now: () => now };
    const verifier = await begin(operationDeps, input);
    await verifier.resolveTarget();
    const allocator = await begin(operationDeps, input);
    await allocator.resolveTarget();
    const cleanupSnapshot = store.pauseNextList();

    const verifying = verifier.recordPhase('verified', {
      checkedBranches: 1,
      branches: [{ name: 'main', expectedSha: 'a'.repeat(40), actualSha: 'a'.repeat(40) }],
      refs: [{ name: 'refs/heads/main', sha: 'a'.repeat(40) }],
    });
    await cleanupSnapshot.captured;

    let active = false;
    const allocationOutcome = await allocator
      .reserveCredentialCleanup({
        username: 'zt-1785837900-000000000001',
        expiresAt: new Date('2026-08-04T10:05:00.000Z'),
      })
      .then(async (allocation) => {
        active = true;
        await allocator.recordCredentialCreated(allocation);
        return 'accepted' as const;
      })
      .catch((error: unknown) =>
        error instanceof Error ? error.message : 'non-error credential coordination failure',
      );
    cleanupSnapshot.resume();
    await verifying;

    expect({
      allocationOutcome,
      verified: [...store.values.keys()].some((key) => key.endsWith('.verified.json')),
      created: [...store.values.keys()].some((key) => key.endsWith('.created.json')),
      released: [...store.values.keys()].some((key) => key.endsWith('.released.json')),
      active,
    }).toEqual({
      allocationOutcome: 'Restore credential allocation is closed',
      verified: true,
      created: false,
      released: false,
      active: false,
    });
  });

  it('rejects an allocation whose write lands after its terminal-fence check', async () => {
    const begin = beginRestoreOperation();
    expect(begin).toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const forgejo = new StatefulForgejo();
    const now = new Date('2026-08-04T10:00:00.000Z');
    const input = {
      kind: 'manual' as const,
      idempotencyKey: 'incident-2026-08-04-late-allocation-write',
      source: SOURCE,
      backupKey: BACKUP_KEY,
    };
    const operationDeps = { store, client: forgejo, now: () => now };
    const allocator = await begin(operationDeps, input);
    await allocator.resolveTarget();
    const verifier = await begin(operationDeps, input);
    await verifier.resolveTarget();
    const allocationWrite = store.pauseNextPutBeforeWrite(/\.allocated\.json$/);

    let active = false;
    const allocating = allocator
      .reserveCredentialCleanup({
        username: 'zt-1785837900-000000000002',
        expiresAt: new Date('2026-08-04T10:05:00.000Z'),
      })
      .then(async (allocation) => {
        active = true;
        await allocator.recordCredentialCreated(allocation);
        return 'accepted' as const;
      })
      .catch((error: unknown) =>
        error instanceof Error ? error.message : 'non-error credential coordination failure',
      );
    await allocationWrite.reached;
    await verifier.recordPhase('verified', {
      checkedBranches: 1,
      branches: [{ name: 'main', expectedSha: 'a'.repeat(40), actualSha: 'a'.repeat(40) }],
      refs: [{ name: 'refs/heads/main', sha: 'a'.repeat(40) }],
    });
    allocationWrite.resume();
    const allocationOutcome = await allocating;

    expect({
      allocationOutcome,
      verified: [...store.values.keys()].some((key) => key.endsWith('.verified.json')),
      allocated: [...store.values.keys()].some((key) => key.endsWith('.allocated.json')),
      created: [...store.values.keys()].some((key) => key.endsWith('.created.json')),
      released: [...store.values.keys()].some((key) => key.endsWith('.released.json')),
      active,
    }).toEqual({
      allocationOutcome: 'Restore credential allocation is closed',
      verified: true,
      allocated: true,
      created: false,
      released: true,
      active: false,
    });
  });

  it('resumes a terminalized result after an accepted creator becomes releasable', async () => {
    const begin = beginRestoreOperation();
    expect(begin).toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const forgejo = new StatefulForgejo();
    const now = new Date('2026-08-04T10:00:00.000Z');
    const input = {
      kind: 'manual' as const,
      idempotencyKey: 'incident-2026-08-04-terminalized-creator-replay',
      source: SOURCE,
      backupKey: BACKUP_KEY,
    };
    const operationDeps = { store, client: forgejo, now: () => now };
    const creator = await begin(operationDeps, input);
    await creator.resolveTarget();
    const allocation = await creator.reserveCredentialCleanup({
      username: 'zt-1785837900-000000000003',
      expiresAt: new Date('2026-08-04T10:05:00.000Z'),
    });
    const result = {
      checkedBranches: 1,
      branches: [{ name: 'main', expectedSha: 'a'.repeat(40), actualSha: 'a'.repeat(40) }],
      refs: [{ name: 'refs/heads/main', sha: 'a'.repeat(40) }],
    };

    await expect(creator.recordPhase('verified', result)).rejects.toThrow(
      'Restore credential creator is still pending',
    );
    let active = true;
    forgejo.deleteUser = () => {
      active = false;
      return Promise.resolve();
    };
    await creator.recordCredentialCreated(allocation);

    const recovery = await begin(operationDeps, input);
    expect(recovery.completedResult).toEqual(result);
    await recovery.resolveTarget();
    await expect(
      recovery.reserveCredentialCleanup({
        username: 'zt-1785837900-000000000004',
        expiresAt: new Date('2026-08-04T10:05:00.000Z'),
      }),
    ).rejects.toThrow('Restore credential allocation is closed');

    expect({
      verified: [...store.values.keys()].some((key) => key.endsWith('.verified.json')),
      created: [...store.values.keys()].some((key) => key.endsWith('.created.json')),
      released: [...store.values.keys()].some((key) => key.endsWith('.released.json')),
      active,
    }).toEqual({ verified: true, created: true, released: true, active: false });
  });

  it('cannot release a creator before its Forgejo user creation is resolved', async () => {
    const begin = beginRestoreOperation();
    expect(begin).toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const now = new Date('2026-08-04T10:00:00.000Z');
    let releaseCreate: (() => void) | undefined;
    const createMayFinish = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let signalCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const users = new Set<string>();
    const grants = new Set<string>();
    let repository:
      | {
          readonly id: number;
          readonly clone_url: string;
          readonly description: string;
          readonly empty: boolean;
        }
      | undefined;
    const forgejo: ForgejoClient = {
      baseUrl: 'https://git.test',
      async send<T>(request: ForgejoRequest): Promise<ForgejoResponse<T>> {
        if (request.method === 'GET' && request.path.startsWith('/orgs/')) {
          return { status: 200, body: { username: 'organization' } as T };
        }
        if (request.method === 'GET' && request.path.startsWith('/repos/')) {
          return repository === undefined
            ? { status: 404, body: undefined }
            : { status: 200, body: repository as T };
        }
        if (request.method === 'POST' && request.path.endsWith('/repos')) {
          const body = request.body as { readonly description: string };
          repository = {
            id: 501,
            clone_url: 'https://git.test/restore/repository.git',
            description: body.description,
            empty: true,
          };
          return { status: 201, body: repository as T };
        }
        if (request.method === 'POST' && request.path === '/admin/users') {
          const body = request.body as { readonly username: string };
          signalCreateStarted?.();
          await createMayFinish;
          users.add(body.username);
          return { status: 201, body: {} as T };
        }
        if (request.method === 'PUT' && request.path.includes('/collaborators/')) {
          const username = decodeURIComponent(request.path.slice(request.path.lastIndexOf('/') + 1));
          if (!users.has(username)) {
            throw new Error('cannot grant a missing restore user');
          }
          grants.add(username);
          return { status: 204, body: undefined };
        }
        if (request.method === 'POST' && request.path.endsWith('/tokens')) {
          return { status: 201, body: { sha1: 'unit-test-token' } as T };
        }
        if (request.method === 'DELETE' && request.path.startsWith('/admin/users/')) {
          const username = decodeURIComponent(
            request.path.slice('/admin/users/'.length).replace(/\?purge=true$/, ''),
          );
          const existed = users.delete(username);
          grants.delete(username);
          return { status: existed ? 204 : 404, body: undefined };
        }
        throw new Error(`unexpected Forgejo request: ${request.method} ${request.path}`);
      },
    };
    const input = {
      kind: 'manual' as const,
      idempotencyKey: 'incident-2026-08-04-credential-create-race',
      source: SOURCE,
      backupKey: BACKUP_KEY,
    };
    const operationDeps = { store, client: forgejo, now: () => now };
    const creator = await begin(operationDeps, input);
    const target = await creator.resolveTarget();
    const issuer = backupScript.createForgejoRestoreCredentialIssuer(
      forgejo,
      createTokenService({
        client: forgejo,
        audit: createRecordingGitAuditSink(),
        now: () => now,
      }),
      240_000,
      { now: () => now },
    );
    const issueInput = {
      sourceOrganizationId: SOURCE.organizationId,
      sourceProjectId: SOURCE.projectId,
      targetRef: creator.targetRef,
      repositoryId: target.repositoryId,
      cloneUrl: target.cloneUrl,
      reserveCredentialCleanup: async (identity: {
        readonly username: string;
        readonly expiresAt: Date;
      }) => await creator.reserveCredentialCleanup(identity),
      recordCredentialCreated: async (allocation: RestoreCredentialAllocation) => {
        await creator.recordCredentialCreated(allocation);
      },
      completeCredentialCleanup: async (allocation: RestoreCredentialAllocation) => {
        await creator.completeCredentialCleanup(allocation);
      },
    };

    const issuing = issuer.issue(issueInput);
    await createStarted;
    const concurrentOutcome = await begin(operationDeps, input).then(
      () => 'continued' as const,
      (error: unknown) =>
        error instanceof Error ? error.message : 'non-error credential coordination failure',
    );
    releaseCreate?.();
    await issuing;
    expect(grants.size).toBe(1);

    const recovery = await begin(operationDeps, input);
    await recovery.resolveTarget();
    await recovery.recordPhase('verified', {
      checkedBranches: 1,
      branches: [{ name: 'main', expectedSha: 'a'.repeat(40), actualSha: 'a'.repeat(40) }],
      refs: [{ name: 'refs/heads/main', sha: 'a'.repeat(40) }],
    });

    expect(concurrentOutcome).toBe('Restore credential creator is still pending');
    expect(users).toEqual(new Set());
    expect(grants).toEqual(new Set());
    const credentialReceipts = [...store.values]
      .filter(([key]) => key.includes('.credentials/'))
      .map(([key, value]) => ({ key, body: value.toString('utf8') }));
    expect(credentialReceipts.map(({ key }) => key)).toEqual([
      expect.stringMatching(/00000001\.allocated\.json$/),
      expect.stringMatching(/00000001\.created\.json$/),
      expect.stringMatching(/00000001\.released\.json$/),
    ]);
    expect(JSON.stringify(credentialReceipts)).not.toMatch(/unit-test-token|password/i);
  });

  it('recovers a pre-create crash only after the allocated identity expires', async () => {
    const begin = beginRestoreOperation();
    expect(begin).toBeTypeOf('function');
    if (begin === undefined) {
      return;
    }
    const store = new ReceiptStore();
    const forgejo = new StatefulForgejo();
    const input = {
      kind: 'manual' as const,
      idempotencyKey: 'incident-2026-08-04-pre-create-crash',
      source: SOURCE,
      backupKey: BACKUP_KEY,
    };
    const beforeExpiry = new Date('2026-08-04T10:04:59.999Z');
    const creator = await begin({ store, client: forgejo, now: () => beforeExpiry }, input);
    await creator.resolveTarget();
    await creator.reserveCredentialCleanup({
      username: 'zt-1785837900-000000000001',
      expiresAt: new Date('2026-08-04T10:05:00.000Z'),
    });

    await expect(
      begin({ store, client: forgejo, now: () => beforeExpiry }, input),
    ).rejects.toThrow('Restore credential creator is still pending');
    expect(
      [...store.values.keys()].some((key) => key.endsWith('.released.json')),
    ).toBe(false);

    const beforeCreateRequestWindowEnds = new Date('2026-08-04T10:05:29.999Z');
    await expect(
      begin(
        { store, client: forgejo, now: () => beforeCreateRequestWindowEnds },
        input,
      ),
    ).rejects.toThrow('Restore credential creator is still pending');

    const afterCreateRequestWindow = new Date('2026-08-04T10:05:30.001Z');
    const recovery = await begin(
      { store, client: forgejo, now: () => afterCreateRequestWindow },
      input,
    );
    await recovery.resolveTarget();
    await recovery.recordPhase('verified', {
      checkedBranches: 0,
      branches: [],
      refs: [],
    });

    expect(
      [...store.values.keys()].filter((key) => key.endsWith('.released.json')),
    ).toHaveLength(1);
  });

  it('computes the restore deadline after issuance latency and caps it before credential expiry', async () => {
    const start = new Date('2026-08-04T10:00:00.000Z').getTime();
    let nowMs = start;
    const expiresAt = new Date(start + 300_000);
    const createIssuer = backupScript.createForgejoRestoreCredentialIssuer as unknown as (
      client: ForgejoClient,
      tokens: {
        mintForRepository(input: {
          onIdentityAllocated?: (identity: {
            readonly username: string;
            readonly expiresAt: Date;
          }) => Promise<void>;
        }): Promise<{
          readonly token: string;
          readonly username: string;
          readonly cloneUrl: string;
          readonly expiresAt: Date;
        }>;
      },
      commandDeadlineMs: number,
      options: { readonly now: () => Date },
    ) => ReturnType<typeof backupScript.createForgejoRestoreCredentialIssuer>;
    const cleanupCallbacks = {
      reserveCredentialCleanup: (identity: {
        readonly username: string;
        readonly expiresAt: Date;
      }) =>
        Promise.resolve({
          version: 1 as const,
          intentKey: 'git-restore-intents/manual/test.json',
          operationId: 'a'.repeat(64),
          targetRef: SOURCE.internalRepoRef,
          repositoryId: 501,
          generation: 1,
          username: identity.username,
          expiresAt: identity.expiresAt.toISOString(),
        }),
      recordCredentialCreated: () => Promise.resolve(),
      completeCredentialCleanup: () => Promise.resolve(),
    };
    const issuer = createIssuer(
      createFakeForgejo(),
      {
        mintForRepository: async (input) => {
          nowMs += 20_000;
          const username = 'zt-1900000001-000000000001';
          await input.onIdentityAllocated?.({ username, expiresAt });
          return {
            token: 'restricted-token',
            username,
            cloneUrl: 'https://git.test/restore/repository.git',
            expiresAt,
          };
        },
      },
      240_000,
      { now: () => new Date(nowMs) },
    );

    const credential = await issuer.issue({
      sourceOrganizationId: ORGANIZATION_ID,
      sourceProjectId: PROJECT_ID,
      targetRef: SOURCE.internalRepoRef,
      repositoryId: 501,
      cloneUrl: 'https://git.test/restore/repository.git',
      ...cleanupCallbacks,
    });

    expect(credential.expiresAt).toEqual(expiresAt);
    expect(credential.deadlineAt).toEqual(new Date(start + 260_000));
    const cappedIssuer = createIssuer(
      createFakeForgejo(),
      {
        mintForRepository: async (input) => {
          const username = 'zt-1900000002-000000000002';
          await input.onIdentityAllocated?.({ username, expiresAt });
          return {
            token: 'restricted-token',
            username,
            cloneUrl: 'https://git.test/restore/repository.git',
            expiresAt,
          };
        },
      },
      299_999,
      { now: () => new Date(nowMs) },
    );
    const capped = await cappedIssuer.issue({
      sourceOrganizationId: ORGANIZATION_ID,
      sourceProjectId: PROJECT_ID,
      targetRef: SOURCE.internalRepoRef,
      repositoryId: 501,
      cloneUrl: 'https://git.test/restore/repository.git',
      ...cleanupCallbacks,
    });
    expect(capped.deadlineAt).toEqual(new Date(start + 295_000));
    expect(() =>
      createIssuer(
        createFakeForgejo(),
        {
          mintForRepository: () => Promise.reject(new Error('must reject before minting')),
        },
        300_000,
        { now: () => new Date(nowMs) },
      ),
    ).toThrow('Invalid restore command deadline');
  });

  it('uses immutable-repository-bound Git access after the target path is replaced', async () => {
    const store = new ReceiptStore();
    store.values.set(BACKUP_KEY, Buffer.from('bundle bytes'));
    const forgejo = new StatefulForgejo();
    const adminGit = new RestoreGit();
    const boundGit = new RestoreGit();
    boundGit.pushMirror = () => {
      boundGit.phases.push('bound-push-refused');
      return Promise.reject(new Error('repository-bound credential cannot reach replacement'));
    };
    const operations = backupScript.createBackupOperations({
      inventory: {
        listProvisionedRepositories: () => Promise.resolve([SOURCE]),
        expectedBranches: () => Promise.resolve([{ name: 'main', headCommitSha: 'a'.repeat(40) }]),
      },
      store,
      git: adminGit,
      restoreGit: adminGit,
      client: forgejo,
      restoreCredentials: {
        issue: (input: { readonly repositoryId: number }) => {
          expect(input.repositoryId).toBe(501);
          forgejo.repository = {
            id: 999,
            clone_url: 'https://git.test/replacement/repository.git',
            description: forgejo.repository?.description ?? '',
            empty: true,
          };
          return Promise.resolve({
            cloneUrl: 'https://git.test/restore/repository.git',
            git: boundGit,
            ...credentialWindow(),
            release: () => Promise.resolve(),
          });
        },
      },
      restoreDrillLease: { runExclusive: async (operation) => await operation() },
      close: () => Promise.resolve(),
    });

    await expect(
      operations.restore({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        key: BACKUP_KEY,
        idempotencyKey: 'incident-2026-08-04-path-replacement',
      }),
    ).rejects.toThrow('Bundle mirror push failed');
    expect(boundGit.phases).toContain('bound-push-refused');
    expect(adminGit.phases).not.toContain('mirror-pushed');
    expect(forgejo.repository?.id).toBe(999);
  });

  it('uses the same repository-bound access to verify refs after a path replacement', async () => {
    const store = new ReceiptStore();
    store.values.set(BACKUP_KEY, Buffer.from('bundle bytes'));
    const forgejo = new StatefulForgejo();
    const adminGit = new RestoreGit();
    const boundGit = new RestoreGit();
    boundGit.pushMirror = () => {
      boundGit.phases.push('mirror-pushed');
      forgejo.repository = {
        id: 999,
        clone_url: 'https://git.test/replacement/repository.git',
        description: forgejo.repository?.description ?? '',
        empty: false,
      };
      return Promise.resolve();
    };
    boundGit.remoteRefs = () => {
      boundGit.phases.push('bound-refs-refused');
      return Promise.reject(new Error('repository-bound credential cannot read replacement'));
    };
    const operations = backupScript.createBackupOperations({
      inventory: {
        listProvisionedRepositories: () => Promise.resolve([SOURCE]),
        expectedBranches: () => Promise.resolve([{ name: 'main', headCommitSha: 'a'.repeat(40) }]),
      },
      store,
      git: adminGit,
      restoreGit: adminGit,
      client: forgejo,
      restoreCredentials: {
        issue: (input) =>
          Promise.resolve({
            cloneUrl: input.cloneUrl,
            git: boundGit,
            ...credentialWindow(),
            release: () => Promise.resolve(),
          }),
      },
      restoreDrillLease: { runExclusive: async (operation) => await operation() },
      close: () => Promise.resolve(),
    });

    await expect(
      operations.restore({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        key: BACKUP_KEY,
        idempotencyKey: 'incident-2026-08-04-ref-replacement',
      }),
    ).rejects.toThrow('Restored branch listing failed');
    expect(boundGit.phases).toEqual(
      expect.arrayContaining(['mirror-pushed', 'bound-refs-refused']),
    );
    expect(adminGit.phases).not.toContain('refs-read');
    expect(forgejo.repository?.id).toBe(999);
  });

  it('reuses one persistent marker-owned drill target without path deletion', async () => {
    const store = new ReceiptStore();
    store.values.set(BACKUP_KEY, Buffer.from('bundle bytes'));
    const forgejo = new StatefulForgejo();
    const git = new RestoreGit();
    const operations = backupScript.createBackupOperations({
      inventory: {
        listProvisionedRepositories: () => Promise.resolve([SOURCE]),
        expectedBranches: () => Promise.resolve([{ name: 'main', headCommitSha: 'a'.repeat(40) }]),
      },
      store,
      git,
      restoreGit: git,
      client: forgejo,
      restoreCredentials: credentialsFor(git),
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

  it('returns the immutable completed drill result without touching newer target refs', async () => {
    const store = new ReceiptStore();
    store.values.set(BACKUP_KEY, Buffer.from('bundle bytes'));
    const forgejo = new StatefulForgejo();
    const git = new RestoreGit();
    let expectedSha = 'a'.repeat(40);
    let credentialIssues = 0;
    let expectedBranchReads = 0;
    const operations = backupScript.createBackupOperations({
      inventory: {
        listProvisionedRepositories: () => Promise.resolve([SOURCE]),
        expectedBranches: () => {
          expectedBranchReads += 1;
          return Promise.resolve([{ name: 'main', headCommitSha: expectedSha }]);
        },
      },
      store,
      git,
      restoreGit: git,
      client: forgejo,
      restoreCredentials: {
        issue: (input) => {
          credentialIssues += 1;
          return credentialsFor(git).issue(input);
        },
      },
      restoreDrillLease: { runExclusive: async (operation) => await operation() },
      close: () => Promise.resolve(),
    });

    const completed = await operations.restoreDrill();
    const mutationCount = git.phases.filter((phase) => phase === 'mirror-pushed').length;
    const forgejoCallCount = forgejo.calls.length;
    expectedSha = 'b'.repeat(40);
    git.refs.set('refs/heads/main', expectedSha);

    await expect(operations.restoreDrill()).resolves.toEqual(completed);
    expect(git.phases.filter((phase) => phase === 'mirror-pushed')).toHaveLength(mutationCount);
    expect(credentialIssues).toBe(1);
    expect(expectedBranchReads).toBe(1);
    expect(forgejo.calls).toHaveLength(forgejoCallCount);
  });

  it('moves an empty drill backup to a separate receipt-owned target instead of retaining old refs', async () => {
    const store = new ReceiptStore();
    store.values.set(BACKUP_KEY, Buffer.from('bundle bytes'));
    const forgejo = new StatefulForgejo();
    const git = new CandidateRestoreGit();
    const targetRefs: string[] = [];
    const operations = backupScript.createBackupOperations({
      inventory: {
        listProvisionedRepositories: () => Promise.resolve([SOURCE]),
        expectedBranches: () => Promise.resolve([]),
      },
      store,
      git,
      restoreGit: git,
      client: forgejo,
      restoreCredentials: {
        issue: (input) => {
          targetRefs.push(input.targetRef);
          return credentialsFor(git).issue(input);
        },
      },
      restoreDrillLease: { runExclusive: async (operation) => await operation() },
      close: () => Promise.resolve(),
    });

    await operations.restoreDrill();
    store.values.set(
      `org/${ORGANIZATION_ID}/project/${PROJECT_ID}/git-backups/2026-08-05.bundle`,
      Buffer.from('empty backup bytes'),
    );
    // The stateful fixture models one URL at a time; the empty representation
    // must resolve a different URL, where Forgejo correctly answers 404.
    forgejo.repository = undefined;
    await operations.restoreDrill();

    expect(targetRefs).toHaveLength(2);
    expect(targetRefs[1]).not.toBe(targetRefs[0]);
    expect(
      forgejo.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/repos')),
    ).toHaveLength(2);
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('selects the first repository whose latest backup verifies for the restore drill', async () => {
    const secondProjectId = newId('proj');
    const secondSource: BackupRepository = {
      ...SOURCE,
      projectId: secondProjectId,
      internalRepoRef: internalRepoRef({
        organizationId: ORGANIZATION_ID,
        projectId: secondProjectId,
      }),
      cloneUrl: `https://git.test/source/${secondProjectId}.git`,
    };
    const secondKey = `org/${ORGANIZATION_ID}/project/${secondProjectId}/git-backups/2026-08-04.bundle`;
    const store = new ReceiptStore();
    store.values.set(BACKUP_KEY, Buffer.from('corrupt bundle'));
    store.values.set(secondKey, Buffer.from('verified bundle'));
    const restoreGit = new CandidateRestoreGit();
    const boundGit = new RestoreGit();
    const forgejo = new StatefulForgejo();
    const expectedBranchProjects: string[] = [];
    const operations = backupScript.createBackupOperations({
      inventory: {
        listProvisionedRepositories: () => Promise.resolve([SOURCE, secondSource]),
        expectedBranches: (_organizationId, projectId) => {
          expectedBranchProjects.push(projectId);
          return Promise.resolve([{ name: 'main', headCommitSha: 'a'.repeat(40) }]);
        },
      },
      store,
      git: restoreGit,
      restoreGit,
      client: forgejo,
      restoreCredentials: credentialsFor(boundGit),
      restoreDrillLease: { runExclusive: async (operation) => await operation() },
      close: () => Promise.resolve(),
    });

    await expect(operations.restoreDrill()).resolves.toMatchObject({
      status: 'restore-drill-verified',
      projectId: secondProjectId,
    });
    expect(restoreGit.verifiedBodies).toEqual([
      'corrupt bundle',
      'verified bundle',
      'verified bundle',
    ]);
    expect(expectedBranchProjects).toEqual([secondProjectId]);
  });

  it('leaves a created target intact but refuses marker-only recovery after receipt loss', async () => {
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
    await expect(retry.resolveTarget()).rejects.toThrow(
      'Restore target has no immutable repository receipt; repository preserved',
    );
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

  it('refuses the marker-matching winner of a GET/POST 409 race without an id receipt', async () => {
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

    await expect(operation.resolveTarget()).rejects.toThrow(
      'Restore target has no immutable repository receipt; repository preserved',
    );
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
    const intent = JSON.parse(store.values.get(operation.intentKey)?.toString('utf8') ?? '{}') as {
      readonly targetMarker?: string;
      readonly targetReceiptKey?: string;
    };
    if (intent.targetMarker === undefined || intent.targetReceiptKey === undefined) {
      throw new Error('restore intent fixture is incomplete');
    }
    store.values.set(
      intent.targetReceiptKey,
      Buffer.from(
        JSON.stringify({
          version: 1,
          targetRef: operation.targetRef,
          repositoryId: 700,
          targetMarker: intent.targetMarker,
        }),
      ),
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
      restoreGit: git,
      client: forgejo,
      restoreCredentials: credentialsFor(git),
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
    const git = new RestoreGit();
    const operations = backupScript.createBackupOperations({
      inventory: {
        listProvisionedRepositories: () => Promise.resolve([SOURCE]),
        expectedBranches: () => Promise.resolve([{ name: 'main', headCommitSha: 'a'.repeat(40) }]),
      },
      store,
      git,
      restoreGit: git,
      client: forgejo,
      restoreCredentials: credentialsFor(git),
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
