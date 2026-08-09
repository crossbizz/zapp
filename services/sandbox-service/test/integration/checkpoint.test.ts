import { newId } from '@zapp/contracts';
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import {
  createCheckpointService,
  type CheckpointRecord,
  type CheckpointServiceDependencies,
} from '../../src/checkpoint/service.js';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

function fixture(overrides: Partial<CheckpointServiceDependencies> = {}) {
  const organizationId = newId('org');
  const projectId = newId('proj');
  const branchId = newId('br');
  const workspaceId = newId('ws');
  const operationKey = `op_${'a'.repeat(64)}`;
  const events: string[] = [];
  const records = new Map<string, CheckpointRecord>();
  const checkpointClaims = new Map<string, string>();
  const restoreClaims = new Map<
    string,
    { fingerprint: string; result?: { checkpointId: string; source: 'snapshot' | 'git_artifact' } }
  >();
  const artifacts = new Map<
    string,
    { bytes: Uint8Array; sha256: string; keyVersion: number }
  >();
  const snapshots = new Set<string>();
  let restoredFile = '';
  let encryptionCount = 0;

  const dependencies: CheckpointServiceDependencies = {
    now: () => new Date('2026-08-08T12:00:00.000Z'),
    git: {
      commitAndPush() {
        events.push('commit-push');
        return Promise.resolve();
      },
      captureUncommitted() {
        events.push('capture');
        return Promise.resolve({
          patch: text('patch:hello.txt'),
          untrackedTar: text('tar:hello from checkpoint'),
        });
      },
      clone() {
        events.push('clone');
        restoredFile = 'committed base';
        return Promise.resolve();
      },
      applyUncommitted(_scope, bundle) {
        events.push('apply');
        expect(new TextDecoder().decode(bundle.patch)).toBe('patch:hello.txt');
        expect(new TextDecoder().decode(bundle.untrackedTar)).toBe('tar:hello from checkpoint');
        restoredFile = 'hello from checkpoint';
        return Promise.resolve();
      },
    },
    codec: {
      compressZstd(bundle) {
        events.push('zstd-compress');
        return Promise.resolve(
          text(
            JSON.stringify({
              patch: Buffer.from(bundle.patch).toString('base64'),
              untrackedTar: Buffer.from(bundle.untrackedTar).toString('base64'),
            }),
          ),
        );
      },
      decompressZstd(value) {
        events.push('zstd-decompress');
        const parsed = JSON.parse(new TextDecoder().decode(value)) as {
          patch: string;
          untrackedTar: string;
        };
        return Promise.resolve({
          patch: Buffer.from(parsed.patch, 'base64'),
          untrackedTar: Buffer.from(parsed.untrackedTar, 'base64'),
        });
      },
    },
    crypto: {
      encrypt(_scope, plaintext) {
        encryptionCount += 1;
        events.push('encrypt');
        return Promise.resolve({
          ciphertext: text(
            `cipher-${String(encryptionCount)}:${Buffer.from(plaintext).toString('base64')}`,
          ),
          keyVersion: encryptionCount,
        });
      },
      decrypt(_scope, encrypted) {
        events.push('decrypt');
        const [version, encoded] = new TextDecoder()
          .decode(encrypted.ciphertext)
          .split(':', 2);
        if (version !== `cipher-${String(encrypted.keyVersion)}`) {
          throw new Error('ciphertext key version mismatch');
        }
        if (encoded === undefined) throw new Error('invalid ciphertext');
        return Promise.resolve(Buffer.from(encoded, 'base64'));
      },
    },
    artifacts: {
      putIfAbsent(input) {
        events.push('artifact-put');
        const existing = artifacts.get(input.key);
        if (existing !== undefined) {
          return Promise.resolve({
            key: input.key,
            sha256: existing.sha256,
            keyVersion: existing.keyVersion,
          });
        }
        const stored = {
          bytes: input.ciphertext,
          sha256: digest(input.ciphertext),
          keyVersion: input.keyVersion,
        };
        artifacts.set(input.key, stored);
        return Promise.resolve({
          key: input.key,
          sha256: stored.sha256,
          keyVersion: stored.keyVersion,
        });
      },
      get(input) {
        events.push('artifact-get');
        expect(input.organizationId).toBe(organizationId);
        expect(input.projectId).toBe(projectId);
        const stored = artifacts.get(input.key);
        return Promise.resolve(stored === undefined ? undefined : stored.bytes);
      },
    },
    snapshots: {
      create(input) {
        events.push('snapshot-create');
        const providerSnapshotId = `snap-${input.checkpointId}`;
        snapshots.add(providerSnapshotId);
        return Promise.resolve({ providerSnapshotId });
      },
      restore(input) {
        events.push('snapshot-restore');
        if (!snapshots.has(input.providerSnapshotId)) return Promise.resolve(false);
        restoredFile = 'hello from checkpoint';
        return Promise.resolve(true);
      },
    },
    records: {
      findByOperationKey(input) {
        return Promise.resolve(
          [...records.values()].find(
            (record) =>
              record.organizationId === input.organizationId &&
              record.projectId === input.projectId &&
              record.operationKey === input.operationKey,
          ),
        );
      },
      claimCheckpoint(input) {
        const fingerprint = JSON.stringify(input);
        const previous = checkpointClaims.get(input.operationKey);
        if (previous !== undefined && previous !== fingerprint) {
          return Promise.resolve({ status: 'conflict' as const });
        }
        checkpointClaims.set(input.operationKey, fingerprint);
        const completed = records.get(input.checkpointId);
        if (completed !== undefined) {
          return Promise.resolve({ status: 'completed' as const, record: completed });
        }
        return Promise.resolve({ status: 'claimed' as const });
      },
      save(record) {
        events.push('record-save');
        records.set(record.checkpointId, record);
        return Promise.resolve(record);
      },
      resolve(input) {
        const matches = [...records.values()].filter(
          (record) =>
            record.organizationId === input.organizationId &&
            record.projectId === input.projectId &&
            record.branchId === input.branchId,
        );
        if (input.checkpointId !== undefined) {
          return Promise.resolve(
            matches.find((record) => record.checkpointId === input.checkpointId),
          );
        }
        return Promise.resolve(matches.at(-1));
      },
      claimRestore(input) {
        const fingerprint = JSON.stringify(input);
        const previous = restoreClaims.get(input.operationKey);
        if (previous !== undefined && previous.fingerprint !== fingerprint) {
          return Promise.resolve({ status: 'conflict' as const });
        }
        if (previous?.result !== undefined) {
          return Promise.resolve({ status: 'completed' as const, result: previous.result });
        }
        restoreClaims.set(input.operationKey, { fingerprint });
        return Promise.resolve({ status: 'claimed' as const });
      },
      completeRestore(input) {
        restoreClaims.set(input.operationKey, {
          fingerprint: JSON.stringify({
            checkpointId: input.checkpointId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            branchId: input.branchId,
            targetWorkspaceId: input.targetWorkspaceId,
            operationKey: input.operationKey,
          }),
          result: input.result,
        });
        return Promise.resolve();
      },
    },
    ...overrides,
  };

  return {
    organizationId,
    projectId,
    branchId,
    workspaceId,
    operationKey,
    dependencies,
    events,
    artifacts,
    snapshots,
    records,
    get restoredFile() {
      return restoredFile;
    },
    get encryptionCount() {
      return encryptionCount;
    },
  };
}

describe('WS-7 checkpoint and snapshot-free restore', () => {
  test('restores uncommitted work from a snapshot, then from Git plus encrypted artifact after snapshot deletion', async () => {
    const state = fixture();
    const service = createCheckpointService(state.dependencies);

    const checkpoint = await service.checkpoint({
      organizationId: state.organizationId,
      projectId: state.projectId,
      branchId: state.branchId,
      workspaceId: state.workspaceId,
      operationKey: state.operationKey,
      kind: 'active',
      taskBoundary: true,
      includeSnapshot: true,
    });

    expect(state.events).toEqual([
      'commit-push',
      'capture',
      'zstd-compress',
      'encrypt',
      'artifact-put',
      'snapshot-create',
      'record-save',
    ]);
    expect(checkpoint.snapshot?.expiresAt).toBe('2026-09-07T12:00:00.000Z');
    expect(state.artifacts.get(checkpoint.artifact.key)?.bytes).not.toEqual(
      text('tar:hello from checkpoint'),
    );

    const snapshotRestore = await service.restore({
      organizationId: state.organizationId,
      projectId: state.projectId,
      branchId: state.branchId,
      checkpointId: checkpoint.checkpointId,
      targetWorkspaceId: newId('ws'),
      operationKey: `op_${'b'.repeat(64)}`,
    });
    expect(snapshotRestore.source).toBe('snapshot');
    expect(state.restoredFile).toBe('hello from checkpoint');

    state.snapshots.delete(checkpoint.snapshot?.providerSnapshotId ?? 'missing');
    const artifactRestore = await service.restore({
      organizationId: state.organizationId,
      projectId: state.projectId,
      branchId: state.branchId,
      checkpointId: checkpoint.checkpointId,
      targetWorkspaceId: newId('ws'),
      operationKey: `op_${'c'.repeat(64)}`,
    });
    expect(artifactRestore.source).toBe('git_artifact');
    expect(state.restoredFile).toBe('hello from checkpoint');
    expect(state.events.slice(-6)).toEqual([
      'snapshot-restore',
      'artifact-get',
      'decrypt',
      'zstd-decompress',
      'clone',
      'apply',
    ]);
  });

  test.each([
    ['active', 30],
    ['diagnostic', 7],
    ['release_evidence', 30],
  ] as const)('records the %s snapshot with the exact %i-day TTL', async (kind, days) => {
    const state = fixture();
    const service = createCheckpointService(state.dependencies);
    const checkpoint = await service.checkpoint({
      organizationId: state.organizationId,
      projectId: state.projectId,
      branchId: state.branchId,
      workspaceId: state.workspaceId,
      operationKey: state.operationKey,
      kind,
      taskBoundary: false,
      includeSnapshot: true,
    });

    expect(checkpoint.snapshot?.expiresAt).toBe(
      new Date(Date.parse('2026-08-08T12:00:00.000Z') + days * 86_400_000).toISOString(),
    );
  });

  test('uses the authoritative stored ciphertext hash after an idempotent retry', async () => {
    let failFirstSave = true;
    const state = fixture();
    const save = state.dependencies.records.save.bind(state.dependencies.records);
    state.dependencies.records.save = async (record) => {
      if (failFirstSave) {
        failFirstSave = false;
        throw new Error('simulated crash after artifact put');
      }
      return save(record);
    };
    const service = createCheckpointService(state.dependencies);
    const input = {
      organizationId: state.organizationId,
      projectId: state.projectId,
      branchId: state.branchId,
      workspaceId: state.workspaceId,
      operationKey: state.operationKey,
      kind: 'diagnostic' as const,
      taskBoundary: false,
      includeSnapshot: false,
    };

    await expect(service.checkpoint(input)).rejects.toThrow('simulated crash');
    const storedHash = [...state.artifacts.values()][0]?.sha256;
    await expect(
      service.checkpoint({ ...input, workspaceId: newId('ws') }),
    ).rejects.toThrow('operation key was already used');
    const retried = await service.checkpoint(input);

    expect(state.encryptionCount).toBe(2);
    expect(retried.artifact.sha256).toBe(storedHash);
    expect(retried.artifact.keyVersion).toBe(1);
    await expect(
      service.restore({
        organizationId: state.organizationId,
        projectId: state.projectId,
        branchId: state.branchId,
        checkpointId: retried.checkpointId,
        targetWorkspaceId: newId('ws'),
        operationKey: `op_${'e'.repeat(64)}`,
      }),
    ).resolves.toMatchObject({ source: 'git_artifact' });
  });

  test('rejects operation-key replay with altered checkpoint input', async () => {
    const state = fixture();
    const service = createCheckpointService(state.dependencies);
    const input = {
      organizationId: state.organizationId,
      projectId: state.projectId,
      branchId: state.branchId,
      workspaceId: state.workspaceId,
      operationKey: state.operationKey,
      kind: 'active' as const,
      taskBoundary: false,
      includeSnapshot: false,
    };
    await service.checkpoint(input);

    await expect(
      service.checkpoint({ ...input, kind: 'diagnostic' }),
    ).rejects.toThrow('operation key was already used');
  });

  test('persists the Git+artifact checkpoint when the optional snapshot is unavailable', async () => {
    const state = fixture();
    state.dependencies.snapshots.create = () =>
      Promise.reject(new Error('snapshot temporarily unavailable'));
    const service = createCheckpointService(state.dependencies);

    const checkpoint = await service.checkpoint({
      organizationId: state.organizationId,
      projectId: state.projectId,
      branchId: state.branchId,
      workspaceId: state.workspaceId,
      operationKey: state.operationKey,
      kind: 'active',
      taskBoundary: false,
      includeSnapshot: true,
    });

    expect(checkpoint.snapshot).toBeNull();
    expect(state.records.get(checkpoint.checkpointId)).toEqual(checkpoint);
  });

  test('rejects cross-tenant and tampered artifacts before mutating the restore target', async () => {
    const state = fixture();
    const service = createCheckpointService(state.dependencies);
    const checkpoint = await service.checkpoint({
      organizationId: state.organizationId,
      projectId: state.projectId,
      branchId: state.branchId,
      workspaceId: state.workspaceId,
      operationKey: state.operationKey,
      kind: 'active',
      taskBoundary: false,
      includeSnapshot: false,
    });
    const restoreInput = {
      organizationId: state.organizationId,
      projectId: state.projectId,
      branchId: state.branchId,
      checkpointId: checkpoint.checkpointId,
      targetWorkspaceId: newId('ws'),
      operationKey: `op_${'d'.repeat(64)}`,
    };

    await expect(
      service.restore({ ...restoreInput, organizationId: newId('org') }),
    ).rejects.toThrow('Checkpoint not found');
    const stored = state.artifacts.get(checkpoint.artifact.key);
    if (stored === undefined) throw new Error('expected checkpoint artifact');
    stored.bytes = text('tampered');
    await expect(service.restore(restoreInput)).rejects.toThrow('integrity check failed');
    expect(state.events.filter((event) => event === 'clone')).toHaveLength(0);
  });

  test('falls back when snapshot restore rejects and deduplicates a keyed restore', async () => {
    const state = fixture();
    const service = createCheckpointService(state.dependencies);
    const checkpoint = await service.checkpoint({
      organizationId: state.organizationId,
      projectId: state.projectId,
      branchId: state.branchId,
      workspaceId: state.workspaceId,
      operationKey: state.operationKey,
      kind: 'active',
      taskBoundary: false,
      includeSnapshot: true,
    });
    state.dependencies.snapshots.restore = () =>
      Promise.reject(new Error('snapshot disappeared during restore'));
    const restoreInput = {
      organizationId: state.organizationId,
      projectId: state.projectId,
      branchId: state.branchId,
      checkpointId: checkpoint.checkpointId,
      targetWorkspaceId: newId('ws'),
      operationKey: `op_${'f'.repeat(64)}`,
    };

    await expect(service.restore(restoreInput)).resolves.toMatchObject({ source: 'git_artifact' });
    await expect(service.restore(restoreInput)).resolves.toMatchObject({ source: 'git_artifact' });
    expect(state.events.filter((event) => event === 'clone')).toHaveLength(1);
    await expect(
      service.restore({ ...restoreInput, targetWorkspaceId: newId('ws') }),
    ).rejects.toThrow('operation key was already used');
  });
});
