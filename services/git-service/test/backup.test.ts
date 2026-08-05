import { access, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  BackupDateSchema,
  backupKey,
  enforceBackupRetention,
  latestBackupKey,
  restoreRepositoryBackup,
  runNightlyBackups,
  runRepositoryBackup,
  type BackupGit,
  type BackupInventory,
  type BackupObject,
  type BackupObjectStore,
  type BackupPutResult,
  type BackupRepository,
  type BackupUploadSource,
  type ExpectedBranch,
  type ResolvedRestoreTarget,
} from '../src/backup.js';

const ORGANIZATION_ID = 'org_01J8ME7YQZJ2V9Q0X3T5B6K7N9';
const PROJECT_ID = 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7N8';
const SECOND_PROJECT_ID = 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7N7';
const REPOSITORY: BackupRepository = {
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  internalRepoRef: 'org_01j8me7yqzj2v9q0x3t5b6k7n9/proj_01j8me7yqzj2v9q0x3t5b6k7n8',
  cloneUrl: 'https://git.test/org_01j8me7yqzj2v9q0x3t5b6k7n9/proj_01j8me7yqzj2v9q0x3t5b6k7n8.git',
  defaultBranch: 'main',
};
const NOW = new Date('2026-08-04T09:30:00.000Z');

async function streamBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

class MemoryStore implements BackupObjectStore {
  readonly values = new Map<string, { body: Buffer; lastModified: Date }>();
  readonly puts: { key: string; streamed: boolean; contentLength: number }[] = [];
  readonly deletes: string[] = [];
  readonly listCalls: { prefix: string; continuationToken?: string }[] = [];
  failPut = false;
  failGet = false;
  pageSize = 1_000;

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.values.has(key));
  }

  async put(key: string, source: BackupUploadSource): Promise<BackupPutResult> {
    if (this.failPut) {
      throw new Error('object-store-secret-was-here');
    }
    if (this.values.has(key)) {
      return 'existing';
    }
    const body = source.open();
    this.puts.push({
      key,
      streamed: body instanceof Readable,
      contentLength: source.contentLength,
    });
    this.values.set(key, { body: await streamBytes(body), lastModified: NOW });
    return 'created';
  }

  get(key: string): Promise<Readable> {
    if (this.failGet) {
      return Promise.reject(new Error('object-store-secret-was-here'));
    }
    const value = this.values.get(key);
    if (value === undefined) {
      return Promise.reject(new Error('not found'));
    }
    return Promise.resolve(Readable.from(value.body));
  }

  list(
    prefix: string,
    continuationToken?: string,
  ): Promise<{ objects: BackupObject[]; continuationToken?: string }> {
    this.listCalls.push({
      prefix,
      ...(continuationToken === undefined ? {} : { continuationToken }),
    });
    const values = [...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right));
    const offset = continuationToken === undefined ? 0 : Number(continuationToken);
    const page = values.slice(offset, offset + this.pageSize).map(([key, value]) => ({
      key,
      lastModified: value.lastModified,
    }));
    const next = offset + this.pageSize;
    return Promise.resolve({
      objects: page,
      ...(next < values.length ? { continuationToken: String(next) } : {}),
    });
  }

  delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.values.delete(key);
    return Promise.resolve();
  }
}

class FakeGit implements BackupGit {
  readonly created: { cloneUrl: string; bundlePath: string }[] = [];
  readonly verified: string[] = [];
  readonly prepared: { bundlePath: string; mirrorPath: string }[] = [];
  readonly pushed: { mirrorPath: string; targetCloneUrl: string; timeoutMs: number }[] = [];
  readonly heads = new Map<string, string>();
  readonly refs = new Map<string, string>();
  fail: 'create' | 'verify' | 'push' | undefined;

  async createBundle(cloneUrl: string, bundlePath: string): Promise<void> {
    this.created.push({ cloneUrl, bundlePath });
    if (this.fail === 'create') {
      throw new Error('forgejo-admin-secret-was-here');
    }
    await writeFile(bundlePath, 'complete bundle bytes');
  }

  verifyBundle(bundlePath: string): Promise<void> {
    this.verified.push(bundlePath);
    if (this.fail === 'verify') {
      return Promise.reject(new Error('forgejo-admin-secret-was-here'));
    }
    return Promise.resolve();
  }

  prepareRestore(bundlePath: string, mirrorPath: string) {
    this.prepared.push({ bundlePath, mirrorPath });
    return Promise.resolve({ kind: 'bundle' as const, mirrorPath });
  }

  pushMirror(mirrorPath: string, targetCloneUrl: string, timeoutMs: number): Promise<void> {
    this.pushed.push({ mirrorPath, targetCloneUrl, timeoutMs });
    if (this.fail === 'push') {
      return Promise.reject(new Error('forgejo-admin-secret-was-here'));
    }
    return Promise.resolve();
  }

  remoteRefs(targetCloneUrl: string, timeoutMs: number): Promise<ReadonlyMap<string, string>> {
    void targetCloneUrl;
    void timeoutMs;
    return Promise.resolve(
      new Map([
        ...[...this.heads].map(([name, sha]) => [`refs/heads/${name}`, sha] as const),
        ...this.refs,
      ]),
    );
  }
}

function restoreTarget(git: FakeGit, cloneUrl: string): ResolvedRestoreTarget {
  const issuedAt = Date.now();
  return {
    cloneUrl,
    git,
    expiresAt: new Date(issuedAt + 300_000),
    deadlineAt: new Date(issuedAt + 240_000),
    release: () => Promise.resolve(),
  };
}

function keyFor(projectId: string, date: string): string {
  return `org/${ORGANIZATION_ID}/project/${projectId}/git-backups/${date}.bundle`;
}

describe('backupKey', () => {
  it('derives the tenant-scoped daily bundle key from validated ids and a UTC date', () => {
    expect(
      backupKey({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        date: '2026-08-04',
      }),
    ).toBe(
      'org/org_01J8ME7YQZJ2V9Q0X3T5B6K7N9/project/proj_01J8ME7YQZJ2V9Q0X3T5B6K7N8/git-backups/2026-08-04.bundle',
    );
  });

  it('rejects path-shaped ids and impossible dates without echoing them', () => {
    expect(() =>
      backupKey({ organizationId: '../another-tenant', projectId: PROJECT_ID, date: '2026-08-04' }),
    ).toThrow('Invalid backup key input');
    expect(() =>
      backupKey({ organizationId: ORGANIZATION_ID, projectId: PROJECT_ID, date: '2026-02-30' }),
    ).toThrow('Invalid backup key input');
  });
});

describe('BackupDateSchema', () => {
  it.each([
    '0000-01-01',
    '2026-00-01',
    '2026-13-01',
    '2026-01-00',
    '2026-01-32',
    '2026-02-29',
    '2026-04-31',
  ])('returns a failed parse rather than throwing for invalid calendar date %s', (date) => {
    let result: ReturnType<typeof BackupDateSchema.safeParse> | undefined;
    expect(() => {
      result = BackupDateSchema.safeParse(date);
    }).not.toThrow();
    expect(result?.success).toBe(false);
  });

  it('accepts a real leap day', () => {
    expect(BackupDateSchema.safeParse('2024-02-29').success).toBe(true);
  });
});

describe('runRepositoryBackup', () => {
  it('creates and verifies a non-empty bundle, then streams it to the exact daily key', async () => {
    const store = new MemoryStore();
    const git = new FakeGit();

    const result = await runRepositoryBackup({ store, git, now: () => NOW }, REPOSITORY);

    expect(result).toEqual({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      key: keyFor(PROJECT_ID, '2026-08-04'),
      status: 'uploaded',
    });
    expect(git.created).toHaveLength(1);
    expect(git.created[0]?.cloneUrl).toBe(REPOSITORY.cloneUrl);
    expect(git.verified).toHaveLength(2);
    expect(git.verified[0]).toBe(git.created[0]?.bundlePath);
    expect(git.verified[1]).not.toBe(git.created[0]?.bundlePath);
    expect(store.puts).toEqual([
      { key: keyFor(PROJECT_ID, '2026-08-04'), streamed: true, contentLength: 21 },
    ]);
    expect(store.values.get(keyFor(PROJECT_ID, '2026-08-04'))?.body.toString()).toBe(
      'complete bundle bytes',
    );
  });

  it('does not rebuild or upload an existing same-day object', async () => {
    const store = new MemoryStore();
    const git = new FakeGit();

    await runRepositoryBackup({ store, git, now: () => NOW }, REPOSITORY);
    const second = await runRepositoryBackup({ store, git, now: () => NOW }, REPOSITORY);

    expect(second.status).toBe('existing');
    expect(git.created).toHaveLength(1);
    expect(store.puts).toHaveLength(1);
    expect(git.verified).toHaveLength(3);
  });

  it.each(['create', 'verify'] as const)(
    'fails closed when Git %s fails and removes scratch data',
    async (failure) => {
      const store = new MemoryStore();
      const git = new FakeGit();
      git.fail = failure;

      await expect(runRepositoryBackup({ store, git, now: () => NOW }, REPOSITORY)).rejects.toThrow(
        failure === 'create' ? 'Git bundle creation failed' : 'Git bundle verification failed',
      );
      expect(store.puts).toHaveLength(0);
      const scratch = git.created[0]?.bundlePath ?? git.verified[0];
      await expect(access(dirname(scratch ?? ''))).rejects.toThrow();
    },
  );

  it('fails closed when upload fails, redacts the dependency error, and removes scratch data', async () => {
    const store = new MemoryStore();
    const git = new FakeGit();
    store.failPut = true;

    let failure: Error | undefined;
    try {
      await runRepositoryBackup({ store, git, now: () => NOW }, REPOSITORY);
    } catch (error) {
      failure = error as Error;
    }

    expect(failure?.message).toBe('Bundle upload failed');
    expect(failure?.message).not.toContain('object-store-secret-was-here');
    await expect(access(dirname(git.created[0]?.bundlePath ?? ''))).rejects.toThrow();
  });
});

describe('enforceBackupRetention', () => {
  it('paginates one project prefix and keeps exactly today through the prior 29 UTC dates', async () => {
    const store = new MemoryStore();
    store.pageSize = 2;
    for (const date of ['2026-01-01', '2026-06-01', '2026-07-05', '2026-07-06', '2026-08-04']) {
      store.values.set(keyFor(PROJECT_ID, date), {
        body: Buffer.from(date),
        lastModified: new Date(`${date}T00:00:00.000Z`),
      });
    }
    store.values.set(keyFor(SECOND_PROJECT_ID, '2025-01-01'), {
      body: Buffer.from('other project'),
      lastModified: new Date('2025-01-01T00:00:00.000Z'),
    });

    await enforceBackupRetention(store, {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      now: NOW,
    });

    expect(store.listCalls).toEqual([
      {
        prefix: `org/${ORGANIZATION_ID}/project/${PROJECT_ID}/git-backups/`,
      },
      {
        prefix: `org/${ORGANIZATION_ID}/project/${PROJECT_ID}/git-backups/`,
        continuationToken: '2',
      },
      {
        prefix: `org/${ORGANIZATION_ID}/project/${PROJECT_ID}/git-backups/`,
        continuationToken: '4',
      },
    ]);
    expect(store.deletes).toEqual([
      keyFor(PROJECT_ID, '2026-01-01'),
      keyFor(PROJECT_ID, '2026-06-01'),
      keyFor(PROJECT_ID, '2026-07-05'),
    ]);
    expect(store.values.has(keyFor(PROJECT_ID, '2026-07-05'))).toBe(false);
    expect(store.values.has(keyFor(PROJECT_ID, '2026-07-06'))).toBe(true);
    expect(store.values.has(keyFor(PROJECT_ID, '2026-08-04'))).toBe(true);
    expect(store.values.has(keyFor(SECOND_PROJECT_ID, '2025-01-01'))).toBe(true);
  });

  it('preserves the newest object even when every object is outside retention', async () => {
    const store = new MemoryStore();
    for (const date of ['2025-01-01', '2025-01-02']) {
      store.values.set(keyFor(PROJECT_ID, date), {
        body: Buffer.from(date),
        lastModified: new Date(`${date}T00:00:00.000Z`),
      });
    }

    await enforceBackupRetention(store, {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      now: NOW,
    });

    expect(store.deletes).toEqual([keyFor(PROJECT_ID, '2025-01-01')]);
    expect(store.values.has(keyFor(PROJECT_ID, '2025-01-02'))).toBe(true);
  });
});

describe('latestBackupKey', () => {
  it('paginates only the project prefix and returns the newest dated bundle', async () => {
    const store = new MemoryStore();
    store.pageSize = 1;
    for (const date of ['2026-08-01', '2026-08-03', '2026-08-02']) {
      store.values.set(keyFor(PROJECT_ID, date), {
        body: Buffer.from(date),
        lastModified: new Date(`${date}T00:00:00.000Z`),
      });
    }
    store.values.set(keyFor(SECOND_PROJECT_ID, '2026-08-04'), {
      body: Buffer.from('other project'),
      lastModified: NOW,
    });

    await expect(
      latestBackupKey(store, { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID }),
    ).resolves.toBe(keyFor(PROJECT_ID, '2026-08-03'));
    expect(store.listCalls).toHaveLength(3);
    expect(
      store.listCalls.every(
        (call) => call.prefix === `org/${ORGANIZATION_ID}/project/${PROJECT_ID}/git-backups/`,
      ),
    ).toBe(true);
  });
});

describe('runNightlyBackups', () => {
  it('reports each repository independently and does not turn a partial failure into success', async () => {
    const store = new MemoryStore();
    const git = new FakeGit();
    const second = {
      ...REPOSITORY,
      projectId: SECOND_PROJECT_ID,
      internalRepoRef: 'org_01j8me7yqzj2v9q0x3t5b6k7n9/proj_01j8me7yqzj2v9q0x3t5b6k7n7',
      cloneUrl:
        'https://git.test/org_01j8me7yqzj2v9q0x3t5b6k7n9/proj_01j8me7yqzj2v9q0x3t5b6k7n7.git',
    } satisfies BackupRepository;
    const inventory: BackupInventory = {
      listProvisionedRepositories: () => Promise.resolve([REPOSITORY, second]),
      expectedBranches: () => Promise.resolve([]),
    };
    const originalPut = store.put.bind(store);
    store.put = async (key, source) => {
      if (key.includes(SECOND_PROJECT_ID)) {
        throw new Error('storage credential');
      }
      return await originalPut(key, source);
    };

    const report = await runNightlyBackups({ inventory, store, git, now: () => NOW });

    expect(report).toEqual({
      succeeded: 1,
      failed: 1,
      repositories: [
        expect.objectContaining({ projectId: PROJECT_ID, status: 'uploaded' }),
        {
          organizationId: ORGANIZATION_ID,
          projectId: SECOND_PROJECT_ID,
          status: 'failed',
          error: 'Bundle upload failed',
        },
      ],
    });
  });
});

describe('restoreRepositoryBackup', () => {
  const branches: ExpectedBranch[] = [
    { name: 'main', headCommitSha: 'a'.repeat(40) },
    { name: 'feature/x', headCommitSha: 'b'.repeat(40) },
    { name: 'unborn', headCommitSha: null },
  ];

  it('prepares locally before issuance and spends one remaining credential budget across remote commands', async () => {
    const store = new MemoryStore();
    const key = keyFor(PROJECT_ID, '2026-08-04');
    store.values.set(key, { body: Buffer.from('bundle bytes'), lastModified: NOW });
    let nowMs = NOW.getTime();
    const events: string[] = [];
    const remoteBudgets: number[] = [];
    const localGit = {
      verifyBundle: () => Promise.resolve(),
      prepareRestore: (_bundlePath: string, mirrorPath: string) => {
        events.push('local-prepared');
        nowMs += 60_000;
        return Promise.resolve({ kind: 'bundle' as const, mirrorPath });
      },
    };
    const remoteGit = {
      pushMirror: (_mirrorPath: string, _cloneUrl: string, timeoutMs: number) => {
        events.push('mirror-pushed');
        remoteBudgets.push(timeoutMs);
        nowMs += 230_000;
        return Promise.resolve();
      },
      remoteRefs: (_cloneUrl: string, timeoutMs?: number) => {
        events.push('refs-read');
        remoteBudgets.push(timeoutMs ?? -1);
        return Promise.resolve(new Map([['refs/heads/main', 'a'.repeat(40)]]));
      },
    };
    const dependencies = {
      store,
      git: localGit,
      now: () => new Date(nowMs),
      resolveTarget: () => {
        expect(events).toEqual(['local-prepared']);
        events.push('credential-issued');
        nowMs += 20_000;
        return Promise.resolve({
          cloneUrl: 'https://git.test/drill/repository.git',
          git: remoteGit,
          expiresAt: new Date(nowMs + 300_000),
          deadlineAt: new Date(nowMs + 240_000),
          release: () => Promise.resolve(),
        });
      },
    };

    await expect(
      restoreRepositoryBackup(dependencies, {
        key,
        expectedBranches: [{ name: 'main', headCommitSha: 'a'.repeat(40) }],
      }),
    ).resolves.toMatchObject({ checkedBranches: 1 });
    expect(events).toEqual(['local-prepared', 'credential-issued', 'mirror-pushed', 'refs-read']);
    expect(remoteBudgets).toEqual([240_000, 10_000]);
  });

  it('refuses the next remote command once the cumulative credential deadline is exhausted', async () => {
    const store = new MemoryStore();
    const key = keyFor(PROJECT_ID, '2026-08-04');
    store.values.set(key, { body: Buffer.from('bundle bytes'), lastModified: NOW });
    let nowMs = NOW.getTime();
    let refReads = 0;
    const localGit = {
      verifyBundle: () => Promise.resolve(),
      prepareRestore: (_bundlePath: string, mirrorPath: string) =>
        Promise.resolve({ kind: 'bundle' as const, mirrorPath }),
    };
    const remoteGit = {
      pushMirror: (_mirrorPath: string, _cloneUrl: string, timeoutMs: number) => {
        expect(timeoutMs).toBe(100);
        nowMs += 100;
        return Promise.resolve();
      },
      remoteRefs: () => {
        refReads += 1;
        return Promise.resolve(new Map([['refs/heads/main', 'a'.repeat(40)]]));
      },
    };
    const dependencies = {
      store,
      git: localGit,
      now: () => new Date(nowMs),
      resolveTarget: () =>
        Promise.resolve({
          cloneUrl: 'https://git.test/drill/repository.git',
          git: remoteGit,
          expiresAt: new Date(nowMs + 5_100),
          deadlineAt: new Date(nowMs + 100),
          release: () => Promise.resolve(),
        }),
    };

    await expect(
      restoreRepositoryBackup(dependencies, {
        key,
        expectedBranches: [{ name: 'main', headCommitSha: 'a'.repeat(40) }],
      }),
    ).rejects.toThrow('Restore credential deadline expired');
    expect(refReads).toBe(0);
  });

  it('rejects a runtime credential window that crosses the expiry safety margin before mutation', async () => {
    const store = new MemoryStore();
    const key = keyFor(PROJECT_ID, '2026-08-04');
    store.values.set(key, { body: Buffer.from('bundle bytes'), lastModified: NOW });
    const nowMs = NOW.getTime();
    let remoteMutations = 0;
    const localGit = {
      verifyBundle: () => Promise.resolve(),
      prepareRestore: (_bundlePath: string, mirrorPath: string) =>
        Promise.resolve({ kind: 'bundle' as const, mirrorPath }),
    };
    const remoteGit = {
      pushMirror: () => {
        remoteMutations += 1;
        return Promise.resolve();
      },
      remoteRefs: () => Promise.resolve(new Map([['refs/heads/main', 'a'.repeat(40)]])),
    };

    await expect(
      restoreRepositoryBackup(
        {
          store,
          git: localGit,
          now: () => new Date(nowMs),
          resolveTarget: () =>
            Promise.resolve({
              cloneUrl: 'https://git.test/drill/repository.git',
              git: remoteGit,
              expiresAt: new Date(nowMs + 300_000),
              deadlineAt: new Date(nowMs + 295_001),
              release: () => Promise.resolve(),
            }),
        },
        { key, expectedBranches: [{ name: 'main', headCommitSha: 'a'.repeat(40) }] },
      ),
    ).rejects.toThrow('Restore credential deadline is invalid');
    expect(remoteMutations).toBe(0);
  });

  it('streams the bundle to scratch, verifies before mirror-push, and checks every non-null branch', async () => {
    const store = new MemoryStore();
    const git = new FakeGit();
    const key = keyFor(PROJECT_ID, '2026-08-04');
    store.values.set(key, { body: Buffer.from('bundle bytes'), lastModified: NOW });
    git.heads.set('main', 'a'.repeat(40));
    git.heads.set('feature/x', 'b'.repeat(40));
    git.refs.set('refs/heads/main', 'a'.repeat(40));
    git.refs.set('refs/heads/feature/x', 'b'.repeat(40));
    git.refs.set('refs/tags/restore-v1', 'c'.repeat(40));
    const result = await restoreRepositoryBackup(
      {
        store,
        git,
        resolveTarget: () =>
          Promise.resolve(restoreTarget(git, 'https://git.test/drill/repository.git')),
      },
      { key, expectedBranches: branches },
    );

    expect(result).toEqual({
      checkedBranches: 2,
      branches: [
        { name: 'feature/x', expectedSha: 'b'.repeat(40), actualSha: 'b'.repeat(40) },
        { name: 'main', expectedSha: 'a'.repeat(40), actualSha: 'a'.repeat(40) },
      ],
      refs: [
        { name: 'refs/heads/feature/x', sha: 'b'.repeat(40) },
        { name: 'refs/heads/main', sha: 'a'.repeat(40) },
        { name: 'refs/tags/restore-v1', sha: 'c'.repeat(40) },
      ],
    });
    expect(git.verified).toHaveLength(1);
    expect(git.prepared).toHaveLength(1);
    expect(git.prepared[0]?.bundlePath).toBe(git.verified[0]);
    expect(git.prepared[0]?.mirrorPath).toBeTypeOf('string');
    expect(git.pushed).toHaveLength(1);
    expect(git.pushed[0]?.mirrorPath).toBe(git.prepared[0]?.mirrorPath);
    expect(git.pushed[0]?.targetCloneUrl).toBe('https://git.test/drill/repository.git');
    expect(git.pushed[0]?.timeoutMs).toBeGreaterThan(0);
    await expect(access(dirname(git.verified[0] ?? ''))).rejects.toThrow();
  });

  it('resolves the durable target only after bundle verification', async () => {
    const store = new MemoryStore();
    const git = new FakeGit();
    const key = keyFor(PROJECT_ID, '2026-08-04');
    store.values.set(key, { body: Buffer.from('bundle bytes'), lastModified: NOW });
    git.heads.set('main', 'a'.repeat(40));
    git.heads.set('feature/x', 'b'.repeat(40));
    let resolutions = 0;

    await restoreRepositoryBackup(
      {
        store,
        git,
        resolveTarget: () => {
          expect(git.verified).toHaveLength(1);
          resolutions += 1;
          return Promise.resolve(restoreTarget(git, 'https://git.test/drill/persistent.git'));
        },
      },
      { key, expectedBranches: branches },
    );

    expect(resolutions).toBe(1);
    expect(git.pushed[0]?.targetCloneUrl).toBe('https://git.test/drill/persistent.git');
  });

  it('does not create a restore target when bundle verification fails', async () => {
    const store = new MemoryStore();
    const git = new FakeGit();
    const key = keyFor(PROJECT_ID, '2026-08-04');
    store.values.set(key, { body: Buffer.from('bundle bytes'), lastModified: NOW });
    git.fail = 'verify';
    let resolutions = 0;

    await expect(
      restoreRepositoryBackup(
        {
          store,
          git,
          resolveTarget: () => {
            resolutions += 1;
            return Promise.resolve(restoreTarget(git, 'https://git.test/drill/persistent.git'));
          },
        },
        { key, expectedBranches: branches },
      ),
    ).rejects.toThrow('Git bundle verification failed');
    expect(resolutions).toBe(0);
  });

  it.each([
    ['missing', new Map([['main', 'a'.repeat(40)]])],
    [
      'mismatched',
      new Map([
        ['main', 'a'.repeat(40)],
        ['feature/x', 'c'.repeat(40)],
      ]),
    ],
  ])(
    'refuses a %s expected branch head without deleting the durable target',
    async (_case, heads) => {
      const store = new MemoryStore();
      const git = new FakeGit();
      const key = keyFor(PROJECT_ID, '2026-08-04');
      store.values.set(key, { body: Buffer.from('bundle bytes'), lastModified: NOW });
      for (const [name, sha] of heads) {
        git.heads.set(name, sha);
      }
      await expect(
        restoreRepositoryBackup(
          {
            store,
            git,
            resolveTarget: () =>
              Promise.resolve(restoreTarget(git, 'https://git.test/drill/repository.git')),
          },
          { key, expectedBranches: branches },
        ),
      ).rejects.toThrow('Restored branch heads do not match the database');
    },
  );

  it('reports a failed mirror push without deleting its durable resumable target', async () => {
    const store = new MemoryStore();
    const git = new FakeGit();
    const key = keyFor(PROJECT_ID, '2026-08-04');
    store.values.set(key, { body: Buffer.from('bundle bytes'), lastModified: NOW });
    git.fail = 'push';
    const phases: string[] = [];

    await expect(
      restoreRepositoryBackup(
        {
          store,
          git,
          resolveTarget: () =>
            Promise.resolve(restoreTarget(git, 'https://git.test/drill/repository.git')),
          recordPhase: (phase) => {
            expect(git.pushed).toHaveLength(0);
            phases.push(phase);
            return Promise.resolve();
          },
        },
        { key, expectedBranches: branches },
      ),
    ).rejects.toThrow('Bundle mirror push failed');
    expect(phases).toEqual(['push-started']);
    await expect(access(dirname(git.verified[0] ?? ''))).rejects.toThrow();
  });

  it('rejects an empty downloaded object before Git verification', async () => {
    const store = new MemoryStore();
    const git = new FakeGit();
    const key = keyFor(PROJECT_ID, '2026-08-04');
    store.values.set(key, { body: Buffer.alloc(0), lastModified: NOW });
    let resolutions = 0;

    await expect(
      restoreRepositoryBackup(
        {
          store,
          git,
          resolveTarget: () => {
            resolutions += 1;
            return Promise.resolve(restoreTarget(git, 'https://git.test/drill/repository.git'));
          },
        },
        { key, expectedBranches: branches },
      ),
    ).rejects.toThrow('Downloaded bundle is empty');
    expect(git.verified).toHaveLength(0);
    expect(resolutions).toBe(0);
  });
});
