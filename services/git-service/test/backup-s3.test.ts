import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import * as backupModule from '../src/backup.js';
import {
  createS3BackupObjectStore,
  type BackupObjectStore,
  type BackupUploadSource,
  type S3ClientPort,
  type S3ClientPortCommand,
} from '../src/backup.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const TIB = 1024 * GIB;

type MultipartUploadLayout = (
  contentLength: number,
  configuredPartSizeBytes: number,
) => { readonly partSizeBytes: number; readonly partCount: number };

function multipartLayout(): MultipartUploadLayout | undefined {
  return (backupModule as { readonly multipartUploadLayout?: MultipartUploadLayout })
    .multipartUploadLayout;
}

interface RecordedS3Call {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly signal: AbortSignal | undefined;
}

class FakeS3 implements S3ClientPort {
  readonly calls: RecordedS3Call[] = [];
  readonly responses: unknown[] = [];
  error: Error | undefined;
  handler: ((call: RecordedS3Call) => unknown) | undefined;

  destroy(): void {}

  send(
    command: S3ClientPortCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown> {
    this.calls.push({
      name: command.constructor.name,
      input: command.input as unknown as Record<string, unknown>,
      signal: options?.abortSignal,
    });
    const call = this.calls.at(-1);
    if (call !== undefined && this.handler !== undefined) {
      return Promise.resolve(this.handler(call));
    }
    if (this.error !== undefined) {
      return Promise.reject(this.error);
    }
    return Promise.resolve(this.responses.shift() ?? {});
  }
}

function source(contentLength: number): {
  readonly source: BackupUploadSource;
  readonly ranges: unknown[];
} {
  const ranges: unknown[] = [];
  return {
    source: {
      contentLength,
      open: (range) => {
        ranges.push(range ?? 'all');
        return Readable.from('bounded test bytes');
      },
    },
    ranges,
  };
}

type MultipartOverrides = Partial<
  Pick<
    Parameters<typeof createS3BackupObjectStore>[0],
    | 'multipartThresholdBytes'
    | 'multipartPartSizeBytes'
    | 'multipartConcurrency'
    | 'uploadDeadlineMs'
    | 'maxAttempts'
    | 'retryBaseDelayMs'
  >
>;

function multipartStore(
  client: S3ClientPort,
  overrides: MultipartOverrides = {},
): BackupObjectStore {
  return createS3BackupObjectStore({
    client,
    createConditionalClient: () => client,
    bucket: 'zapp-artifacts',
    timeoutMs: 3_000,
    multipartThresholdBytes: 10 * 1024 * 1024,
    multipartPartSizeBytes: 5 * 1024 * 1024,
    multipartConcurrency: 2,
    uploadDeadlineMs: 5_000,
    maxAttempts: 2,
    retryBaseDelayMs: 1,
    ...overrides,
  });
}

describe('createS3BackupObjectStore', () => {
  it.each([
    [5 * TIB - 1, 5 * MIB, 549_755_814, 10_000],
    [5 * TIB, 5 * MIB, 549_755_814, 10_000],
    [5 * TIB, GIB, GIB, 5_120],
    [5 * TIB, 5 * GIB, 5 * GIB, 1_024],
    [10 * GIB + 1, 5 * MIB, 5 * MIB, 2_049],
  ])(
    'plans %i bytes with configured part size %i inside R2 limits',
    (contentLength, configuredPartSize, partSizeBytes, partCount) => {
      const plan = multipartLayout();
      expect(plan, 'multipart sizing helper is missing').toBeTypeOf('function');
      expect(plan?.(contentLength, configuredPartSize)).toEqual({ partSizeBytes, partCount });
    },
  );

  it.each([5 * MIB - 1, 5 * GIB + 1])(
    'rejects configured multipart part size %i outside R2 limits',
    (configuredPartSize) => {
      expect(() => multipartLayout()?.(5 * GIB, configuredPartSize)).toThrow(
        'Invalid multipart part size',
      );
    },
  );

  it.each([5 * MIB, 5 * MIB + 1, 5 * GIB - 1, 5 * GIB])(
    'accepts configured multipart part size %i at R2 boundaries',
    (configuredPartSize) => {
      expect(multipartLayout()?.(5 * GIB, configuredPartSize).partSizeBytes).toBe(
        configuredPartSize,
      );
    },
  );

  it('rejects an object above R2 maximum before starting an upload', async () => {
    const client = new FakeS3();
    const store = multipartStore(client);

    await expect(store.put('too-large.bundle', source(5 * TIB + 1).source)).rejects.toThrow(
      'R2 object size limit',
    );
    expect(client.calls).toEqual([]);
  });

  it('uses single PUT just below 5 GiB and multipart at and above 5 GiB', async () => {
    const client = new FakeS3();
    let upload = 0;
    client.handler = (call) => {
      if (call.name === 'CreateMultipartUploadCommand') {
        upload += 1;
        return { UploadId: `upload-${String(upload)}` };
      }
      if (call.name === 'UploadPartCommand') {
        return { ETag: `etag-${String(call.input['PartNumber'])}` };
      }
      return {};
    };
    const store = multipartStore(client, {
      multipartThresholdBytes: 5 * GIB,
      multipartPartSizeBytes: 5 * GIB,
      multipartConcurrency: 1,
    });

    await expect(store.put('below.bundle', source(5 * GIB - 1).source)).resolves.toBe('created');
    await expect(store.put('at.bundle', source(5 * GIB).source)).resolves.toBe('created');
    await expect(store.put('above.bundle', source(5 * GIB + 1).source)).resolves.toBe('created');

    expect(client.calls.filter((call) => call.name === 'PutObjectCommand')).toHaveLength(1);
    expect(
      client.calls.filter((call) => call.name === 'CreateMultipartUploadCommand'),
    ).toHaveLength(2);
    expect(
      client.calls
        .filter((call) => call.name === 'UploadPartCommand')
        .map((call) => call.input['ContentLength']),
    ).toEqual([5 * GIB, 5 * GIB, 1]);
  });

  it('increases the effective part size so a configured upload never exceeds 10,000 parts', async () => {
    const client = new FakeS3();
    client.handler = (call) => {
      if (call.name === 'CreateMultipartUploadCommand') {
        return { UploadId: 'derived-layout' };
      }
      if (call.name === 'UploadPartCommand') {
        return { ETag: `etag-${String(call.input['PartNumber'])}` };
      }
      return {};
    };
    const contentLength = 5 * MIB * 10_000 + 1;
    const upload = source(contentLength);
    const store = multipartStore(client, { multipartConcurrency: 16 });

    await expect(store.put('ten-thousand-parts.bundle', upload.source)).resolves.toBe('created');

    const partCalls = client.calls.filter((call) => call.name === 'UploadPartCommand');
    expect(partCalls).toHaveLength(10_000);
    expect(partCalls[0]?.input['ContentLength']).toBe(5 * MIB + 1);
    expect(upload.ranges).toHaveLength(10_000);
    expect(upload.ranges[0]).toEqual({ start: 0, endExclusive: 5 * MIB + 1 });
    expect(upload.ranges.at(-1)).toEqual({
      start: (5 * MIB + 1) * 9_999,
      endExclusive: contentLength,
    });
  });
  it('uses conditional PutObject below the multipart threshold', async () => {
    const client = new FakeS3();
    const store = multipartStore(client);
    const upload = source(12);

    await expect(
      store.put('org/o/project/p/git-backups/2026-08-04.bundle', upload.source),
    ).resolves.toBe('created');

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      name: 'PutObjectCommand',
      input: {
        Bucket: 'zapp-artifacts',
        Key: 'org/o/project/p/git-backups/2026-08-04.bundle',
        ContentLength: 12,
        ContentType: 'application/x-git-bundle',
        IfNoneMatch: '*',
      },
    });
    expect(client.calls[0]?.input['Body']).toBeInstanceOf(Readable);
    expect(upload.ranges).toEqual(['all']);
    expect(client.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('treats a conditional single-write race as existing without overwriting it', async () => {
    const client = new FakeS3();
    const store = multipartStore(client);
    client.error = Object.assign(new Error('precondition failed'), {
      $metadata: { httpStatusCode: 412 },
    });
    await expect(store.put('key', source(3).source)).resolves.toBe('existing');
    expect(client.calls[0]?.input).toMatchObject({ IfNoneMatch: '*' });
  });

  it('uses bounded multipart parts and conditionally completes the final key', async () => {
    const client = new FakeS3();
    let activeParts = 0;
    let maximumActiveParts = 0;
    client.handler = async (call) => {
      if (call.name === 'CreateMultipartUploadCommand') {
        return { UploadId: 'upload-1' };
      }
      if (call.name === 'UploadPartCommand') {
        activeParts += 1;
        maximumActiveParts = Math.max(maximumActiveParts, activeParts);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeParts -= 1;
        return { ETag: `etag-${String(call.input['PartNumber'])}` };
      }
      return {};
    };
    const store = multipartStore(client);
    const upload = source(12 * 1024 * 1024);

    await expect(store.put('large.bundle', upload.source)).resolves.toBe('created');

    expect(client.calls.map((call) => call.name)).toEqual([
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'CompleteMultipartUploadCommand',
    ]);
    expect(upload.ranges).toEqual([
      { start: 0, endExclusive: 5 * 1024 * 1024 },
      { start: 5 * 1024 * 1024, endExclusive: 10 * 1024 * 1024 },
      { start: 10 * 1024 * 1024, endExclusive: 12 * 1024 * 1024 },
    ]);
    expect(maximumActiveParts).toBe(2);
    expect(client.calls.at(-1)?.input).toMatchObject({
      UploadId: 'upload-1',
      IfNoneMatch: '*',
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: 'etag-1' },
          { PartNumber: 2, ETag: 'etag-2' },
          { PartNumber: 3, ETag: 'etag-3' },
        ],
      },
    });
  });

  it('reopens and retries a failed part, then aborts when attempts are exhausted', async () => {
    const client = new FakeS3();
    let partAttempts = 0;
    client.handler = (call) => {
      if (call.name === 'CreateMultipartUploadCommand') {
        return Promise.resolve({ UploadId: 'upload-retry' });
      }
      if (call.name === 'UploadPartCommand') {
        partAttempts += 1;
        return Promise.reject(
          Object.assign(new Error('retryable part failure'), {
            $metadata: { httpStatusCode: 500 },
          }),
        );
      }
      return Promise.resolve({});
    };
    const store = multipartStore(client, { multipartConcurrency: 1 });
    const upload = source(11 * 1024 * 1024);

    await expect(store.put('failed-large.bundle', upload.source)).rejects.toThrow(
      'retryable part failure',
    );

    expect(partAttempts).toBe(2);
    expect(client.calls.at(-1)?.name).toBe('AbortMultipartUploadCommand');
    expect(client.calls.at(-1)?.input).toMatchObject({ UploadId: 'upload-retry' });
    expect(upload.ranges.slice(0, 2)).toEqual([
      { start: 0, endExclusive: 5 * 1024 * 1024 },
      { start: 0, endExclusive: 5 * 1024 * 1024 },
    ]);
  });

  it('retries ECONNRESET with a fresh single-upload body stream', async () => {
    const client = new FakeS3();
    let attempts = 0;
    client.handler = () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
      }
      return {};
    };
    const upload = source(12);
    const store = multipartStore(client);

    await expect(store.put('network-retry.bundle', upload.source)).resolves.toBe('created');
    expect(client.calls).toHaveLength(2);
    expect(upload.ranges).toEqual(['all', 'all']);
    expect(client.calls[0]?.input['Body']).not.toBe(client.calls[1]?.input['Body']);
  });

  it('retries ETIMEDOUT multipart parts with the exact range reopened', async () => {
    const client = new FakeS3();
    let firstPartAttempts = 0;
    client.handler = (call) => {
      if (call.name === 'CreateMultipartUploadCommand') {
        return { UploadId: 'transport-retry' };
      }
      if (call.name === 'UploadPartCommand') {
        if (call.input['PartNumber'] === 1) {
          firstPartAttempts += 1;
          if (firstPartAttempts === 1) {
            throw Object.assign(new Error('transport timeout'), { code: 'ETIMEDOUT' });
          }
        }
        return { ETag: `etag-${String(call.input['PartNumber'])}` };
      }
      return {};
    };
    const upload = source(11 * MIB);
    const store = multipartStore(client, { multipartConcurrency: 1 });

    await expect(store.put('part-network-retry.bundle', upload.source)).resolves.toBe('created');
    expect(firstPartAttempts).toBe(2);
    expect(upload.ranges.slice(0, 2)).toEqual([
      { start: 0, endExclusive: 5 * MIB },
      { start: 0, endExclusive: 5 * MIB },
    ]);
  });

  it('does not retry a non-transient transport error', async () => {
    const client = new FakeS3();
    const failure = Object.assign(new Error('local access denied'), { code: 'EACCES' });
    client.error = failure;
    const store = multipartStore(client);

    await expect(store.put('non-retryable.bundle', source(12).source)).rejects.toBe(failure);
    expect(client.calls).toHaveLength(1);
  });

  it('reconciles an ambiguous multipart completion that already published the final key', async () => {
    const client = new FakeS3();
    client.handler = (call) => {
      if (call.name === 'CreateMultipartUploadCommand') {
        return { UploadId: 'ambiguous-published' };
      }
      if (call.name === 'UploadPartCommand') {
        return { ETag: `etag-${String(call.input['PartNumber'])}` };
      }
      if (call.name === 'CompleteMultipartUploadCommand') {
        throw Object.assign(new Error('response socket reset'), { code: 'ECONNRESET' });
      }
      if (call.name === 'HeadObjectCommand') {
        return { ContentLength: 11 * MIB };
      }
      return {};
    };
    const store = multipartStore(client);

    await expect(store.put('ambiguous-published.bundle', source(11 * MIB).source)).resolves.toBe(
      'existing',
    );
    expect(
      client.calls.filter((call) => call.name === 'CompleteMultipartUploadCommand'),
    ).toHaveLength(1);
    expect(client.calls.filter((call) => call.name === 'HeadObjectCommand')).toHaveLength(1);
    expect(client.calls.filter((call) => call.name === 'AbortMultipartUploadCommand')).toHaveLength(
      1,
    );
  });

  it('reconciles an ambiguous completion even when the retry budget is exhausted', async () => {
    const client = new FakeS3();
    client.handler = (call) => {
      if (call.name === 'CreateMultipartUploadCommand') {
        return { UploadId: 'last-attempt-published' };
      }
      if (call.name === 'UploadPartCommand') {
        return { ETag: `etag-${String(call.input['PartNumber'])}` };
      }
      if (call.name === 'CompleteMultipartUploadCommand') {
        throw Object.assign(new Error('last response timed out'), { code: 'ETIMEDOUT' });
      }
      if (call.name === 'HeadObjectCommand') {
        return { ContentLength: 11 * MIB };
      }
      return {};
    };
    const store = multipartStore(client, { maxAttempts: 1 });

    await expect(store.put('last-attempt-published.bundle', source(11 * MIB).source)).resolves.toBe(
      'existing',
    );
    expect(client.calls.filter((call) => call.name === 'HeadObjectCommand')).toHaveLength(1);
  });

  it('reconciles an ambiguous conditional single PUT before reporting failure', async () => {
    const client = new FakeS3();
    client.handler = (call) => {
      if (call.name === 'PutObjectCommand') {
        throw Object.assign(new Error('publish response reset'), { code: 'ECONNRESET' });
      }
      if (call.name === 'HeadObjectCommand') {
        return { ContentLength: 12 };
      }
      return {};
    };
    const store = multipartStore(client, { maxAttempts: 1 });

    await expect(store.put('single-published.bundle', source(12).source)).resolves.toBe('existing');
    expect(client.calls.map((call) => call.name)).toEqual([
      'PutObjectCommand',
      'HeadObjectCommand',
    ]);
  });

  it('disposes each isolated conditional client after success or stream reset', async () => {
    let stored = false;
    let conditionalClients = 0;
    let destroyed = 0;
    let sharedDestroyed = 0;
    const client: S3ClientPort = {
      send: (command) => {
        if (command.constructor.name === 'HeadObjectCommand') {
          return Promise.resolve({ ContentLength: 12 });
        }
        return Promise.resolve({});
      },
      destroy: () => {
        sharedDestroyed += 1;
      },
    };
    const store = createS3BackupObjectStore({
      client,
      createConditionalClient: () => {
        conditionalClients += 1;
        return {
          send: () => {
            if (!stored) {
              stored = true;
              return Promise.resolve({});
            }
            return Promise.reject(
              Object.assign(new Error('precondition rejected before consuming stream'), {
                code: 'ECONNRESET',
                $metadata: { httpStatusCode: 412 },
              }),
            );
          },
          destroy: () => {
            destroyed += 1;
          },
        };
      },
      bucket: 'zapp-artifacts',
      timeoutMs: 3_000,
      multipartThresholdBytes: 10 * MIB,
      multipartPartSizeBytes: 5 * MIB,
      multipartConcurrency: 2,
      uploadDeadlineMs: 5_000,
      maxAttempts: 1,
      retryBaseDelayMs: 1,
    });
    const upload = source(12).source;

    await expect(store.put('conditional-reset.json', upload)).resolves.toBe('created');
    await expect(store.put('conditional-reset.json', upload)).resolves.toBe('existing');
    await expect(store.exists('conditional-reset.json')).resolves.toBe(true);
    expect(conditionalClients).toBe(2);
    expect(destroyed).toBe(2);
    expect(sharedDestroyed).toBe(0);
  });

  it('does not abort a concurrent multipart upload when a conditional request resets', async () => {
    const sharedCalls: string[] = [];
    const conditionalCalls: RecordedS3Call[] = [];
    const pendingParts: {
      readonly partNumber: number;
      readonly resolve: (value: { readonly ETag: string }) => void;
      readonly reject: (error: Error) => void;
    }[] = [];
    let allowParts = false;
    let signalPartStarted: (() => void) | undefined;
    const partStarted = new Promise<void>((resolve) => {
      signalPartStarted = resolve;
    });
    let sharedDestroyed = 0;
    let conditionalDestroyed = 0;
    const shared: S3ClientPort = {
      send(command) {
        const name = command.constructor.name;
        const input = command.input as unknown as Record<string, unknown>;
        sharedCalls.push(name);
        if (name === 'CreateMultipartUploadCommand') {
          return Promise.resolve({ UploadId: 'concurrent-upload' });
        }
        if (name === 'UploadPartCommand') {
          const partNumber = Number(input['PartNumber']);
          signalPartStarted?.();
          if (allowParts) {
            return Promise.resolve({ ETag: `etag-${String(partNumber)}` });
          }
          return new Promise((resolve, reject) => {
            pendingParts.push({ partNumber, resolve, reject });
          });
        }
        if (name === 'PutObjectCommand') {
          return Promise.reject(
            Object.assign(new Error('conditional stream reset'), {
              code: 'ECONNRESET',
              $metadata: { httpStatusCode: 412 },
            }),
          );
        }
        return Promise.resolve({});
      },
      destroy() {
        sharedDestroyed += 1;
        for (const part of pendingParts.splice(0)) {
          part.reject(new Error('shared client destroy aborted multipart part'));
        }
      },
    };
    const conditional: S3ClientPort = {
      send(command, options) {
        conditionalCalls.push({
          name: command.constructor.name,
          input: command.input as unknown as Record<string, unknown>,
          signal: options?.abortSignal,
        });
        return Promise.reject(
          Object.assign(new Error('conditional stream reset'), {
            code: 'ECONNRESET',
            $metadata: { httpStatusCode: 412 },
          }),
        );
      },
      destroy() {
        conditionalDestroyed += 1;
      },
    };
    const options = {
      client: shared,
      createConditionalClient: () => conditional,
      bucket: 'zapp-artifacts',
      timeoutMs: 3_000,
      multipartThresholdBytes: 10 * MIB,
      multipartPartSizeBytes: 5 * MIB,
      multipartConcurrency: 2,
      uploadDeadlineMs: 5_000,
      maxAttempts: 1,
      retryBaseDelayMs: 1,
    };
    const store = createS3BackupObjectStore(options);

    const multipart = store.put('multipart.bundle', source(11 * MIB).source).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await partStarted;
    const conditionalResult = await store.put('existing.json', source(12).source);
    allowParts = true;
    for (const part of pendingParts.splice(0)) {
      part.resolve({ ETag: `etag-${String(part.partNumber)}` });
    }
    const multipartOutcome = await multipart;

    expect(conditionalResult).toBe('existing');
    expect(multipartOutcome).toEqual({ result: 'created' });
    expect(sharedCalls).toContain('CompleteMultipartUploadCommand');
    expect(sharedDestroyed).toBe(0);
    expect(conditionalDestroyed).toBe(1);
    expect(conditionalCalls[0]?.input).toMatchObject({ IfNoneMatch: '*' });
  });

  it('reconciles an aborted single PUT with a fresh independently bounded HEAD signal', async () => {
    const client = new FakeS3();
    let uploadSignal: AbortSignal | undefined;
    client.handler = (call) => {
      if (call.name === 'PutObjectCommand') {
        uploadSignal = call.signal;
        return new Promise((_resolve, reject) => {
          call.signal?.addEventListener(
            'abort',
            () => {
              reject(Object.assign(new Error('deadline expired'), { code: 'ETIMEDOUT' }));
            },
            { once: true },
          );
        });
      }
      if (call.name === 'HeadObjectCommand') {
        expect(call.signal).not.toBe(uploadSignal);
        expect(call.signal?.aborted).toBe(false);
        return { ContentLength: 12 };
      }
      return {};
    };
    const store = multipartStore(client, { uploadDeadlineMs: 100, maxAttempts: 1 });

    await expect(store.put('single-timeout-published.bundle', source(12).source)).resolves.toBe(
      'existing',
    );
    expect(client.calls.map((call) => call.name)).toEqual([
      'PutObjectCommand',
      'HeadObjectCommand',
    ]);
  });

  it('reports the original aborted PUT when fresh reconciliation proves the key absent', async () => {
    const client = new FakeS3();
    const timeout = Object.assign(new Error('deadline expired'), { code: 'ETIMEDOUT' });
    client.handler = (call) => {
      if (call.name === 'PutObjectCommand') {
        return new Promise((_resolve, reject) => {
          call.signal?.addEventListener(
            'abort',
            () => {
              reject(timeout);
            },
            { once: true },
          );
        });
      }
      if (call.name === 'HeadObjectCommand') {
        throw Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } });
      }
      return {};
    };
    const store = multipartStore(client, { uploadDeadlineMs: 100, maxAttempts: 1 });

    await expect(store.put('single-timeout-absent.bundle', source(12).source)).rejects.toBe(
      timeout,
    );
    expect(client.calls.map((call) => call.name)).toEqual([
      'PutObjectCommand',
      'HeadObjectCommand',
    ]);
  });

  it('reports a fresh reconciliation failure instead of guessing after an aborted PUT', async () => {
    const client = new FakeS3();
    const reconciliationFailure = Object.assign(new Error('head unavailable'), {
      code: 'EACCES',
    });
    client.handler = (call) => {
      if (call.name === 'PutObjectCommand') {
        return new Promise((_resolve, reject) => {
          call.signal?.addEventListener(
            'abort',
            () => {
              reject(Object.assign(new Error('deadline expired'), { code: 'ETIMEDOUT' }));
            },
            { once: true },
          );
        });
      }
      if (call.name === 'HeadObjectCommand') {
        throw reconciliationFailure;
      }
      return {};
    };
    const store = multipartStore(client, { uploadDeadlineMs: 100, maxAttempts: 1 });

    await expect(store.put('single-timeout-unknown.bundle', source(12).source)).rejects.toBe(
      reconciliationFailure,
    );
    expect(client.calls.map((call) => call.name)).toEqual([
      'PutObjectCommand',
      'HeadObjectCommand',
    ]);
  });

  it('retries multipart completion only after an ambiguous response reconciles as absent', async () => {
    const client = new FakeS3();
    let completions = 0;
    client.handler = (call) => {
      if (call.name === 'CreateMultipartUploadCommand') {
        return { UploadId: 'ambiguous-absent' };
      }
      if (call.name === 'UploadPartCommand') {
        return { ETag: `etag-${String(call.input['PartNumber'])}` };
      }
      if (call.name === 'CompleteMultipartUploadCommand') {
        completions += 1;
        if (completions === 1) {
          throw Object.assign(new Error('response timed out'), { code: 'ETIMEDOUT' });
        }
        return {};
      }
      if (call.name === 'HeadObjectCommand') {
        throw Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } });
      }
      return {};
    };
    const store = multipartStore(client);

    await expect(store.put('ambiguous-absent.bundle', source(11 * MIB).source)).resolves.toBe(
      'created',
    );
    expect(completions).toBe(2);
    expect(client.calls.filter((call) => call.name === 'HeadObjectCommand')).toHaveLength(1);
    expect(client.calls.filter((call) => call.name === 'AbortMultipartUploadCommand')).toEqual([]);
  });

  it('reconciles an aborted multipart completion with a fresh independently bounded HEAD signal', async () => {
    const client = new FakeS3();
    let completionSignal: AbortSignal | undefined;
    client.handler = (call) => {
      if (call.name === 'CreateMultipartUploadCommand') {
        return { UploadId: 'completion-timeout' };
      }
      if (call.name === 'UploadPartCommand') {
        return { ETag: `etag-${String(call.input['PartNumber'])}` };
      }
      if (call.name === 'CompleteMultipartUploadCommand') {
        completionSignal = call.signal;
        return new Promise((_resolve, reject) => {
          call.signal?.addEventListener(
            'abort',
            () => {
              reject(Object.assign(new Error('deadline expired'), { code: 'ETIMEDOUT' }));
            },
            { once: true },
          );
        });
      }
      if (call.name === 'HeadObjectCommand') {
        expect(call.signal).not.toBe(completionSignal);
        expect(call.signal?.aborted).toBe(false);
        return { ContentLength: 11 * MIB };
      }
      return {};
    };
    const store = multipartStore(client, { uploadDeadlineMs: 100, maxAttempts: 1 });

    await expect(
      store.put('multipart-timeout-published.bundle', source(11 * MIB).source),
    ).resolves.toBe('existing');
    expect(client.calls.filter((call) => call.name === 'HeadObjectCommand')).toHaveLength(1);
    expect(client.calls.filter((call) => call.name === 'AbortMultipartUploadCommand')).toHaveLength(
      1,
    );
  });

  it.each(['absent', 'unknown'] as const)(
    'reports an aborted multipart completion honestly when fresh reconciliation is %s',
    async (reconciliation) => {
      const client = new FakeS3();
      const timeout = Object.assign(new Error('deadline expired'), { code: 'ETIMEDOUT' });
      const headFailure = Object.assign(new Error('head unavailable'), { code: 'EACCES' });
      let completionSignal: AbortSignal | undefined;
      client.handler = (call) => {
        if (call.name === 'CreateMultipartUploadCommand') {
          return { UploadId: `completion-${reconciliation}` };
        }
        if (call.name === 'UploadPartCommand') {
          return { ETag: `etag-${String(call.input['PartNumber'])}` };
        }
        if (call.name === 'CompleteMultipartUploadCommand') {
          completionSignal = call.signal;
          return new Promise((_resolve, reject) => {
            call.signal?.addEventListener(
              'abort',
              () => {
                reject(timeout);
              },
              { once: true },
            );
          });
        }
        if (call.name === 'HeadObjectCommand') {
          expect(call.signal).not.toBe(completionSignal);
          expect(call.signal?.aborted).toBe(false);
          throw reconciliation === 'absent'
            ? Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } })
            : headFailure;
        }
        return {};
      };
      const store = multipartStore(client, { uploadDeadlineMs: 100, maxAttempts: 1 });
      const result = store.put(
        `multipart-timeout-${reconciliation}.bundle`,
        source(11 * MIB).source,
      );

      if (reconciliation === 'absent') {
        await expect(result).rejects.toBe(timeout);
      } else {
        await expect(result).rejects.toBe(headFailure);
      }
      expect(client.calls.filter((call) => call.name === 'HeadObjectCommand')).toHaveLength(1);
      expect(
        client.calls.filter((call) => call.name === 'AbortMultipartUploadCommand'),
      ).toHaveLength(1);
    },
  );

  it('aborts incomplete parts after the shared upload deadline', async () => {
    const client = new FakeS3();
    client.handler = (call) => {
      if (call.name === 'CreateMultipartUploadCommand') {
        return Promise.resolve({ UploadId: 'upload-timeout' });
      }
      if (call.name === 'UploadPartCommand') {
        return new Promise((_resolve, reject) => {
          call.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('deadline expired'));
            },
            { once: true },
          );
        });
      }
      return Promise.resolve({});
    };
    const store = multipartStore(client, { uploadDeadlineMs: 100 });

    await expect(store.put('timed-out.bundle', source(11 * 1024 * 1024).source)).rejects.toThrow(
      'deadline expired',
    );

    expect(client.calls.at(-1)?.name).toBe('AbortMultipartUploadCommand');
    expect(client.calls.at(-1)?.signal?.aborted).toBe(false);
  });

  it('lets exactly one concurrent multipart completion create the key', async () => {
    const client = new FakeS3();
    let uploads = 0;
    let completed = false;
    client.handler = (call) => {
      if (call.name === 'CreateMultipartUploadCommand') {
        uploads += 1;
        return { UploadId: `upload-${String(uploads)}` };
      }
      if (call.name === 'UploadPartCommand') {
        return { ETag: `${String(call.input['UploadId'])}-${String(call.input['PartNumber'])}` };
      }
      if (call.name === 'CompleteMultipartUploadCommand') {
        expect(call.input['IfNoneMatch']).toBe('*');
        if (completed) {
          throw Object.assign(new Error('precondition failed'), {
            $metadata: { httpStatusCode: 412 },
          });
        }
        completed = true;
      }
      return {};
    };
    const first = multipartStore(client);
    const second = multipartStore(client);

    const results = await Promise.all([
      first.put('same-key.bundle', source(11 * 1024 * 1024).source),
      second.put('same-key.bundle', source(11 * 1024 * 1024).source),
    ]);

    expect(results.sort()).toEqual(['created', 'existing']);
    expect(client.calls.filter((call) => call.name === 'AbortMultipartUploadCommand')).toHaveLength(
      1,
    );
  });

  it('propagates a non-retryable single-upload failure', async () => {
    const client = new FakeS3();
    const store = multipartStore(client);

    client.error = Object.assign(new Error('forbidden'), {
      $metadata: { httpStatusCode: 403 },
    });
    await expect(store.put('key', source(3).source)).rejects.toBe(client.error);
  });

  it('checks existence with HeadObject and treats only 404 as absent', async () => {
    const client = new FakeS3();
    const store = createS3BackupObjectStore({
      client,
      createConditionalClient: () => client,
      bucket: 'zapp-artifacts',
      timeoutMs: 3_000,
    });
    await expect(store.exists('present')).resolves.toBe(true);

    client.error = Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } });
    await expect(store.exists('absent')).resolves.toBe(false);

    client.error = Object.assign(new Error('forbidden'), { $metadata: { httpStatusCode: 403 } });
    await expect(store.exists('unknown')).rejects.toBe(client.error);
  });

  it('returns the GetObject stream without buffering it', async () => {
    const client = new FakeS3();
    const body = Readable.from('bundle bytes');
    client.responses.push({ Body: body });
    const store = createS3BackupObjectStore({
      client,
      createConditionalClient: () => client,
      bucket: 'zapp-artifacts',
      timeoutMs: 3_000,
    });

    await expect(store.get('key')).resolves.toBe(body);
    expect(client.calls[0]?.name).toBe('GetObjectCommand');
  });

  it('maps one ListObjectsV2 page and carries the opaque continuation token', async () => {
    const client = new FakeS3();
    client.responses.push({
      Contents: [
        { Key: 'prefix/2026-08-03.bundle', LastModified: new Date('2026-08-03T00:00:00Z') },
      ],
      NextContinuationToken: 'opaque-next-page',
    });
    const store = createS3BackupObjectStore({
      client,
      createConditionalClient: () => client,
      bucket: 'zapp-artifacts',
      timeoutMs: 3_000,
    });

    await expect(store.list('prefix/', 'opaque-current-page')).resolves.toEqual({
      objects: [
        {
          key: 'prefix/2026-08-03.bundle',
          lastModified: new Date('2026-08-03T00:00:00Z'),
        },
      ],
      continuationToken: 'opaque-next-page',
    });
    expect(client.calls[0]).toMatchObject({
      name: 'ListObjectsV2Command',
      input: {
        Bucket: 'zapp-artifacts',
        Prefix: 'prefix/',
        ContinuationToken: 'opaque-current-page',
      },
    });
  });

  it('deletes exactly the supplied object key with a deadline', async () => {
    const client = new FakeS3();
    const store = createS3BackupObjectStore({
      client,
      createConditionalClient: () => client,
      bucket: 'zapp-artifacts',
      timeoutMs: 3_000,
    });

    await store.delete('org/exact/project/exact/git-backups/old.bundle');

    expect(client.calls[0]).toMatchObject({
      name: 'DeleteObjectCommand',
      input: {
        Bucket: 'zapp-artifacts',
        Key: 'org/exact/project/exact/git-backups/old.bundle',
      },
    });
    expect(client.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});
