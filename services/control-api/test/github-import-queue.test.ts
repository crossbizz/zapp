import { ChangeMessageVisibilityCommand, SQSClient } from '@aws-sdk/client-sqs';
import { newId } from '@zapp/contracts';
import {
  CapabilityScanUnavailableError,
  type CapabilityScanPort,
} from '@zapp/project-adapters';
import { describe, expect, it, vi } from 'vitest';

import { GitServiceImportConflictError, type GitServicePort } from '../src/git/port.js';
import {
  createGitHubImportConsumerLifecycle,
  createGitHubImportWorker,
  createSqsGitHubImportQueue,
  GitHubImportQueueMessageSchema,
  type GitHubImportQueuePort,
} from '../src/integrations/github/import-queue.js';
import {
  CompleteGitHubImportMirrorInputSchema,
  CompleteGitHubImportScanInputSchema,
  type CompleteGitHubImportMirrorInput,
  type CompleteGitHubImportScanInput,
  type GitHubImportWorkerRecord,
  type GitHubImportWorkerStore,
} from '../src/integrations/github/import-store.js';
import {
  GitHubImportProviderError,
  type GitHubProviderPort,
} from '../src/integrations/github/ports.js';
import { TEST_CAPABILITY_SCAN } from './support/harness.js';
import { AcceptGitHubImportInputSchema } from '../src/tenant/db.js';

const ORGANIZATION = newId('org');
const PROJECT = newId('proj');
const BRANCH_ID = newId('br');
const NOW = new Date('2026-08-10T12:00:00.000Z');
const HEAD = 'a'.repeat(40);
const SOURCE_TOKEN = 'github-installation-token';

function importRow(status: GitHubImportWorkerRecord['status'] = 'queued'): GitHubImportWorkerRecord {
  return {
    projectId: PROJECT,
    organizationId: ORGANIZATION,
    installationId: '41122',
    repo: 'zapp/example',
    branch: 'feature/import',
    operationKey: 'github-import-operation-0001',
    status,
    externalRepoRef: status === 'queued' || status === 'mirroring' ? null : 'zapp/example',
    headCommitSha: status === 'queued' || status === 'mirroring' ? null : HEAD,
    scanId:
      status === 'queued' || status === 'mirroring' ? null : `github-import:${PROJECT}`,
    errorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
    branchId: status === 'queued' || status === 'mirroring' ? null : BRANCH_ID,
  };
}

class MemoryWorkerStore implements GitHubImportWorkerStore {
  record: GitHubImportWorkerRecord;
  reads = 0;
  deliveries: string[] = [];
  mirrorCompletions = 0;
  scanCompletions = 0;
  failNextMirrorCompletion = false;
  failNextScanCompletion = false;

  constructor(record: GitHubImportWorkerRecord = importRow()) {
    this.record = record;
  }

  read(projectId: string): Promise<GitHubImportWorkerRecord | undefined> {
    this.reads += 1;
    return Promise.resolve(projectId === this.record.projectId ? { ...this.record } : undefined);
  }

  markMirroring(projectId: string, now: Date): Promise<GitHubImportWorkerRecord | undefined> {
    if (projectId !== this.record.projectId) return Promise.resolve(undefined);
    if (this.record.status === 'queued') this.record = { ...this.record, status: 'mirroring', updatedAt: now };
    return Promise.resolve({ ...this.record });
  }

  completeMirror(input: CompleteGitHubImportMirrorInput): Promise<GitHubImportWorkerRecord> {
    this.mirrorCompletions += 1;
    if (this.failNextMirrorCompletion) {
      this.failNextMirrorCompletion = false;
      return Promise.reject(new Error('process stopped before mirror state committed'));
    }
    this.record = {
      ...this.record,
      status: 'scan_pending',
      externalRepoRef: input.externalRepoRef,
      headCommitSha: input.headCommitSha,
      scanId: input.scanId,
      branchId: BRANCH_ID,
      errorCode: null,
      updatedAt: input.now,
    };
    this.deliveries.push('scan_pending');
    return Promise.resolve({ ...this.record });
  }

  recordRetryableFailure(
    projectId: string,
    errorCode: GitHubImportWorkerRecord['errorCode'],
    now: Date,
  ) {
    if (projectId === this.record.projectId) {
      this.record = { ...this.record, errorCode, updatedAt: now };
    }
    return Promise.resolve();
  }

  fail(projectId: string, errorCode: GitHubImportWorkerRecord['errorCode'], now: Date) {
    if (projectId === this.record.projectId) {
      this.record = { ...this.record, status: 'failed', errorCode, updatedAt: now };
    }
    return Promise.resolve();
  }

  completeScan(input: CompleteGitHubImportScanInput): Promise<void> {
    this.scanCompletions += 1;
    if (this.failNextScanCompletion) {
      this.failNextScanCompletion = false;
      return Promise.reject(new Error('process stopped before scan state committed'));
    }
    this.record = {
      ...this.record,
      status: 'scan_accepted',
      errorCode: null,
      updatedAt: input.now,
    };
    return Promise.resolve();
  }
}

class ImportProvider implements GitHubProviderPort {
  prepareCalls = 0;
  failure: Error | undefined;

  completeInstallation = () => Promise.resolve({ installationId: '41122' });
  listRepositories = () => Promise.resolve({ items: [], nextCursor: null });
  listBranches = () => Promise.resolve({ items: [], nextCursor: null });
  prepareImport() {
    this.prepareCalls += 1;
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve({
      sourceCloneUrl: 'https://github.test/zapp/example.git',
      sourceToken: SOURCE_TOKEN,
    });
  }
}

class ImportGitService implements GitServicePort {
  importCalls = 0;
  failure: Error | undefined;

  createRepository = () => Promise.reject(new Error('not used'));
  importRepository() {
    this.importCalls += 1;
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve({
      externalRepoRef: 'zapp/example',
      branch: 'feature/import',
      headCommitSha: HEAD,
    });
  }
}

function worker(options: {
  readonly store?: MemoryWorkerStore;
  readonly provider?: ImportProvider;
  readonly git?: ImportGitService;
  readonly scan?: CapabilityScanPort;
} = {}) {
  const store = options.store ?? new MemoryWorkerStore();
  const provider = options.provider ?? new ImportProvider();
  const git = options.git ?? new ImportGitService();
  const scans: Parameters<CapabilityScanPort['scan']>[0][] = [];
  const scan = options.scan ?? {
    async scan(input) {
      scans.push(input);
      return await TEST_CAPABILITY_SCAN.scan(input);
    },
  };
  return {
    store,
    provider,
    git,
    scans,
    worker: createGitHubImportWorker({ store, provider, git, capabilityScan: scan, now: () => NOW }),
  };
}

const queuedMessage = GitHubImportQueueMessageSchema.parse({ projectId: PROJECT, stage: 'queued' });
const scanMessage = GitHubImportQueueMessageSchema.parse({
  projectId: PROJECT,
  stage: 'scan_pending',
});

class ManualTimers {
  private nextHandle = 1;
  readonly active = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();
  readonly cleared: number[] = [];

  setInterval(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.active.set(handle, { callback, delayMs });
    return handle;
  }

  clearInterval(rawHandle: number | object): void {
    const handle = Number(rawHandle);
    this.cleared.push(handle);
    this.active.delete(handle);
  }

  handleBelow(delayMs: number): number | undefined {
    return [...this.active].find(([, entry]) => entry.delayMs < delayMs)?.[0];
  }

  handleAt(delayMs: number): number | undefined {
    return [...this.active].find(([, entry]) => entry.delayMs === delayMs)?.[0];
  }

  async fire(handle: number): Promise<void> {
    this.active.get(handle)?.callback();
    await Promise.resolve();
    await Promise.resolve();
  }
}

class VisibilityQueue implements GitHubImportQueuePort {
  nowMs = 0;
  visibleAtMs = 0;
  mainReceives = 0;
  inDeadLetterQueue = false;
  failHeartbeat = false;
  readonly extensions: number[] = [];
  readonly deleted: Array<{ readonly queue: 'main' | 'dlq'; readonly receipt: string }> = [];

  send(): Promise<void> {
    return Promise.resolve();
  }

  receive(
    queueName: 'main' | 'dlq',
    input: {
      readonly maxMessages: number;
      readonly waitTimeSeconds: number;
      readonly visibilityTimeoutSeconds: number;
    },
  ): Promise<readonly { readonly body: string; readonly receiptHandle: string }[]> {
    if (queueName === 'dlq') {
      return Promise.resolve(
        this.inDeadLetterQueue
          ? [{ body: JSON.stringify(scanMessage), receiptHandle: 'dlq-receipt' }]
          : [],
      );
    }
    if (this.inDeadLetterQueue || this.nowMs < this.visibleAtMs) return Promise.resolve([]);
    if (this.mainReceives > 0) {
      this.inDeadLetterQueue = true;
      return Promise.resolve([]);
    }
    this.mainReceives += 1;
    this.visibleAtMs = this.nowMs + input.visibilityTimeoutSeconds * 1_000;
    return Promise.resolve([{ body: JSON.stringify(scanMessage), receiptHandle: 'main-receipt' }]);
  }

  changeVisibility(
    queueName: 'main' | 'dlq',
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    if (this.failHeartbeat) return Promise.reject(new Error('visibility extension failed'));
    expect(queueName).toBe('main');
    expect(receiptHandle).toBe('main-receipt');
    this.extensions.push(visibilityTimeoutSeconds);
    this.visibleAtMs = this.nowMs + visibilityTimeoutSeconds * 1_000;
    return Promise.resolve();
  }

  delete(queueName: 'main' | 'dlq', receiptHandle: string): Promise<void> {
    this.deleted.push({ queue: queueName, receipt: receiptHandle });
    return Promise.resolve();
  }

  advance(milliseconds: number): void {
    this.nowMs += milliseconds;
  }
}

describe('durable GitHub import worker', () => {
  it('rejects unknown fields at acceptance, mirror, and scan persistence boundaries', () => {
    expect(
      AcceptGitHubImportInputSchema.safeParse({
        projectId: PROJECT,
        installationId: '41122',
        repo: 'zapp/example',
        branch: 'feature/import',
        operationKey: 'github-import-operation-0001',
        now: NOW,
        sourceToken: SOURCE_TOKEN,
      }).success,
    ).toBe(false);
    expect(
      CompleteGitHubImportMirrorInputSchema.safeParse({
        projectId: PROJECT,
        externalRepoRef: 'zapp/example',
        branch: 'feature/import',
        headCommitSha: HEAD,
        scanId: `github-import:${PROJECT}`,
        now: NOW,
        sourceToken: SOURCE_TOKEN,
      }).success,
    ).toBe(false);
    expect(
      CompleteGitHubImportScanInputSchema.safeParse({
        projectId: PROJECT,
        output: {
          result: { unsupported: [], guarded: [], detected: [] },
          reportArtifact: { key: 'scan-report', sha256: 'a'.repeat(64), sizeBytes: 1 },
        },
        now: NOW,
        sourceToken: SOURCE_TOKEN,
      }).success,
    ).toBe(false);
  });

  it('advances queued to scan_pending, then scan_pending to scan_accepted one delivery at a time', async () => {
    const wired = worker();

    await wired.worker.process(JSON.stringify(queuedMessage));
    expect(wired.store.record).toMatchObject({
      status: 'scan_pending',
      externalRepoRef: 'zapp/example',
      headCommitSha: HEAD,
      branchId: BRANCH_ID,
      errorCode: null,
    });
    expect(wired.store.deliveries).toEqual(['scan_pending']);
    expect(wired.scans).toEqual([]);

    await wired.worker.process(JSON.stringify(scanMessage));
    expect(wired.store.record.status).toBe('scan_accepted');
    expect(wired.scans).toHaveLength(1);
    expect(wired.scans[0]).toMatchObject({
      scanId: `github-import:${PROJECT}`,
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      branchId: BRANCH_ID,
      branchName: 'feature/import',
      idempotencyKey: `capability-scan:${ORGANIZATION}:${PROJECT}:github-import:${PROJECT}`,
    });
    expect(wired.store.reads).toBe(2);
  });

  it('resumes persisted mirroring after provider failure and after a process dies at mirror commit', async () => {
    const provider = new ImportProvider();
    provider.failure = new GitHubImportProviderError('github_unavailable');
    const store = new MemoryWorkerStore();
    const wired = worker({ store, provider });

    await expect(wired.worker.process(JSON.stringify(queuedMessage))).rejects.toThrow();
    expect(store.record).toMatchObject({ status: 'mirroring', errorCode: 'github_unavailable' });
    provider.failure = undefined;
    store.failNextMirrorCompletion = true;
    await expect(wired.worker.process(JSON.stringify(queuedMessage))).rejects.toThrow(
      'process stopped before mirror state committed',
    );
    expect(store.record.status).toBe('mirroring');

    await wired.worker.process(JSON.stringify(queuedMessage));
    expect(store.record.status).toBe('scan_pending');
    expect(provider.prepareCalls).toBe(3);
    expect(wired.git.importCalls).toBe(2);
    expect(store.reads).toBe(3);
  });

  it('replays the exact keyed scan after a process dies before accepting it', async () => {
    const store = new MemoryWorkerStore(importRow('scan_pending'));
    store.failNextScanCompletion = true;
    const scanInputs: Parameters<CapabilityScanPort['scan']>[0][] = [];
    const scan: CapabilityScanPort = {
      async scan(input) {
        scanInputs.push(input);
        return await TEST_CAPABILITY_SCAN.scan(input);
      },
    };
    const wired = worker({ store, scan });

    await expect(wired.worker.process(JSON.stringify(scanMessage))).rejects.toThrow(
      'process stopped before scan state committed',
    );
    expect(store.record.status).toBe('scan_pending');
    await wired.worker.process(JSON.stringify(scanMessage));
    expect(store.record.status).toBe('scan_accepted');
    expect(scanInputs).toHaveLength(2);
    expect(scanInputs[1]).toEqual(scanInputs[0]);
    expect(store.reads).toBe(2);
  });

  it('settles a mirror conflict immediately but leaves retryable outages pending', async () => {
    const conflictGit = new ImportGitService();
    conflictGit.failure = new GitServiceImportConflictError();
    const conflict = worker({ git: conflictGit });
    await conflict.worker.process(JSON.stringify(queuedMessage));
    expect(conflict.store.record).toMatchObject({ status: 'failed', errorCode: 'mirror_failed' });

    const unavailableProvider = new ImportProvider();
    unavailableProvider.failure = new GitHubImportProviderError('github_unavailable');
    const retry = worker({ provider: unavailableProvider });
    await expect(retry.worker.process(JSON.stringify(queuedMessage))).rejects.toThrow();
    expect(retry.store.record).toMatchObject({ status: 'mirroring', errorCode: 'github_unavailable' });

    const unavailableScan: CapabilityScanPort = {
      scan: () => Promise.reject(new CapabilityScanUnavailableError()),
    };
    const scanRetry = worker({
      store: new MemoryWorkerStore(importRow('scan_pending')),
      scan: unavailableScan,
    });
    await expect(scanRetry.worker.process(JSON.stringify(scanMessage))).rejects.toThrow();
    expect(scanRetry.store.record).toMatchObject({
      status: 'scan_pending',
      errorCode: 'scan_unavailable',
    });
  });

  it('settles an exhausted delivery from the DLQ and no-ops duplicates that already advanced', async () => {
    const wired = worker();
    await wired.worker.settleDeadLetter(JSON.stringify(queuedMessage));
    expect(wired.store.record).toMatchObject({ status: 'failed', errorCode: 'mirror_failed' });

    const acceptedStore = new MemoryWorkerStore(importRow('scan_accepted'));
    const accepted = worker({ store: acceptedStore });
    await accepted.worker.process(JSON.stringify(queuedMessage));
    await accepted.worker.process(JSON.stringify(scanMessage));
    expect(accepted.provider.prepareCalls).toBe(0);
    expect(accepted.scans).toEqual([]);
    expect(acceptedStore.reads).toBe(2);
  });
});

describe('GitHub import queue lifecycle', () => {
  it('extends an active delivery beyond one visibility window so it cannot compete or reach the DLQ', async () => {
    const queue = new VisibilityQueue();
    const timers = new ManualTimers();
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifecycle = createGitHubImportConsumerLifecycle({
      queue,
      worker: { process: () => blocked, settleDeadLetter: () => Promise.resolve() },
      batchSize: 1,
      waitTimeSeconds: 0,
      visibilityTimeoutSeconds: 3,
      intervalMs: 60_000,
      timers,
    });

    const starting = lifecycle.start();
    await Promise.resolve();
    await Promise.resolve();
    const leaseHandle = timers.handleBelow(3_000);
    expect(leaseHandle).toBeDefined();
    if (leaseHandle === undefined) throw new Error('visibility heartbeat was not scheduled');

    for (let heartbeat = 0; heartbeat < 4; heartbeat += 1) {
      queue.advance(2_500);
      await timers.fire(leaseHandle);
    }
    expect(queue.nowMs).toBeGreaterThan(3_000);
    expect(queue.extensions).toEqual([3, 3, 3, 3]);
    await expect(
      queue.receive('main', {
        maxMessages: 1,
        waitTimeSeconds: 0,
        visibilityTimeoutSeconds: 3,
      }),
    ).resolves.toEqual([]);
    await expect(
      queue.receive('dlq', {
        maxMessages: 1,
        waitTimeSeconds: 0,
        visibilityTimeoutSeconds: 3,
      }),
    ).resolves.toEqual([]);

    release();
    await starting;
    expect(queue.deleted).toContainEqual({ queue: 'main', receipt: 'main-receipt' });
    expect(timers.cleared).toContain(leaseHandle);
    await lifecycle.close();
  });

  it('keeps a heartbeat failure recoverable and cleans the lease after worker failure', async () => {
    const queue = new VisibilityQueue();
    queue.failHeartbeat = true;
    const timers = new ManualTimers();
    const errors: string[] = [];
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifecycle = createGitHubImportConsumerLifecycle({
      queue,
      worker: { process: () => blocked, settleDeadLetter: () => Promise.resolve() },
      batchSize: 1,
      waitTimeSeconds: 0,
      visibilityTimeoutSeconds: 3,
      intervalMs: 60_000,
      onError: (error) => errors.push(error.message),
      timers,
    });

    const starting = lifecycle.start();
    await Promise.resolve();
    await Promise.resolve();
    const leaseHandle = timers.handleBelow(3_000);
    expect(leaseHandle).toBeDefined();
    if (leaseHandle === undefined) throw new Error('visibility heartbeat was not scheduled');
    await timers.fire(leaseHandle);
    await Promise.resolve();
    release();
    await starting;

    expect(errors).toEqual(['visibility extension failed']);
    expect(queue.deleted).toEqual([]);
    expect(timers.cleared).toContain(leaseHandle);
    queue.advance(3_001);
    await queue.receive('main', {
      maxMessages: 1,
      waitTimeSeconds: 0,
      visibilityTimeoutSeconds: 3,
    });
    await expect(
      queue.receive('dlq', {
        maxMessages: 1,
        waitTimeSeconds: 0,
        visibilityTimeoutSeconds: 3,
      }),
    ).resolves.toEqual([
      { body: JSON.stringify(scanMessage), receiptHandle: 'dlq-receipt' },
    ]);
    await lifecycle.close();

    const failedQueue = new VisibilityQueue();
    const failedTimers = new ManualTimers();
    const failedLifecycle = createGitHubImportConsumerLifecycle({
      queue: failedQueue,
      worker: {
        process: () => Promise.reject(new Error('scan failed')),
        settleDeadLetter: () => Promise.resolve(),
      },
      batchSize: 1,
      waitTimeSeconds: 0,
      visibilityTimeoutSeconds: 3,
      intervalMs: 60_000,
      timers: failedTimers,
    });
    await failedLifecycle.start();
    expect(failedQueue.deleted).toEqual([]);
    expect(failedTimers.handleBelow(3_000)).toBeUndefined();
    expect(failedTimers.cleared).toHaveLength(1);
    await failedLifecycle.close();
  });

  it('deletes accepted main and settled DLQ messages and drains a leased message on shutdown', async () => {
    const deleted: Array<{ queue: 'main' | 'dlq'; receipt: string }> = [];
    const extensions: string[] = [];
    const timers = new ManualTimers();
    let mainMessages: readonly { body: string; receiptHandle: string }[] = [];
    let dlqMessages: readonly { body: string; receiptHandle: string }[] = [];
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let processes = 0;
    const queue: GitHubImportQueuePort = {
      send: () => Promise.resolve(),
      receive(queueName) {
        return Promise.resolve(queueName === 'main' ? mainMessages : dlqMessages);
      },
      changeVisibility(queueName, receiptHandle) {
        extensions.push(`${queueName}:${receiptHandle}`);
        return Promise.resolve();
      },
      delete(queueName, receiptHandle) {
        deleted.push({ queue: queueName, receipt: receiptHandle });
        return Promise.resolve();
      },
    };
    const lifecycle = createGitHubImportConsumerLifecycle({
      queue,
      worker: {
        async process() {
          processes += 1;
          if (processes === 2) await blocked;
        },
        settleDeadLetter: () => Promise.resolve(),
      },
      batchSize: 10,
      waitTimeSeconds: 0,
      visibilityTimeoutSeconds: 30,
      intervalMs: 1_000,
      timers,
    });

    mainMessages = [{ body: JSON.stringify(queuedMessage), receiptHandle: 'main-1' }];
    dlqMessages = [{ body: JSON.stringify(scanMessage), receiptHandle: 'dlq-1' }];
    await lifecycle.start();
    expect(deleted).toEqual([
      { queue: 'main', receipt: 'main-1' },
      { queue: 'dlq', receipt: 'dlq-1' },
    ]);

    mainMessages = [{ body: JSON.stringify(queuedMessage), receiptHandle: 'main-2' }];
    dlqMessages = [];
    const pollHandle = timers.handleAt(1_000);
    expect(pollHandle).toBeDefined();
    if (pollHandle === undefined) throw new Error('poll was not scheduled');
    await timers.fire(pollHandle);
    await Promise.resolve();
    let closed = false;
    const closing = lifecycle.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    const leaseHandle = timers.handleAt(10_000);
    expect(leaseHandle).toBeDefined();
    if (leaseHandle === undefined) throw new Error('shutdown lease was not scheduled');
    await timers.fire(leaseHandle);
    expect(extensions).toContain('main:main-2');
    release();
    await closing;
    expect(deleted).toContainEqual({ queue: 'main', receipt: 'main-2' });
    expect(timers.active.size).toBe(0);
  });
});

describe('SQS GitHub import queue', () => {
  it('uses ChangeMessageVisibility and clamps each lease to the SQS bound', async () => {
    const send = vi
      .spyOn(SQSClient.prototype, 'send')
      .mockResolvedValue({ QueueUrl: 'https://sqs.test/queue' } as never);
    try {
      const queue = createSqsGitHubImportQueue({
        region: 'us-west-2',
        endpoint: 'https://sqs.test',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
        queueName: 'github-imports',
        deadLetterQueueName: 'github-imports-dlq',
      });

      await queue.changeVisibility('main', 'receipt-1', 99_999);

      const command = send.mock.calls.at(-1)?.[0];
      expect(command).toBeInstanceOf(ChangeMessageVisibilityCommand);
      expect((command as ChangeMessageVisibilityCommand).input).toEqual({
        QueueUrl: 'https://sqs.test/queue',
        ReceiptHandle: 'receipt-1',
        VisibilityTimeout: 43_200,
      });
      queue.close?.();
    } finally {
      send.mockRestore();
    }
  });
});
