import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createS3BackupObjectStore,
  type BackupObjectStore,
  type BackupUploadSource,
  type S3ClientPort,
  type S3ClientPortCommand,
} from '../src/backup.js';

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
    const store = createS3BackupObjectStore({ client, bucket: 'zapp-artifacts', timeoutMs: 3_000 });
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
    const store = createS3BackupObjectStore({ client, bucket: 'zapp-artifacts', timeoutMs: 3_000 });

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
    const store = createS3BackupObjectStore({ client, bucket: 'zapp-artifacts', timeoutMs: 3_000 });

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
    const store = createS3BackupObjectStore({ client, bucket: 'zapp-artifacts', timeoutMs: 3_000 });

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
