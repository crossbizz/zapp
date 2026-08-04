import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createS3BackupObjectStore,
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

  send(
    command: S3ClientPortCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown> {
    this.calls.push({
      name: command.constructor.name,
      input: command.input as unknown as Record<string, unknown>,
      signal: options?.abortSignal,
    });
    if (this.error !== undefined) {
      return Promise.reject(this.error);
    }
    return Promise.resolve(this.responses.shift() ?? {});
  }
}

describe('createS3BackupObjectStore', () => {
  it('uploads the original stream with a bounded conditional PutObject', async () => {
    const client = new FakeS3();
    const store = createS3BackupObjectStore({ client, bucket: 'zapp-artifacts', timeoutMs: 3_000 });
    const body = Readable.from('bundle bytes');

    await store.put('org/o/project/p/git-backups/2026-08-04.bundle', body, 12);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      name: 'PutObjectCommand',
      input: {
        Bucket: 'zapp-artifacts',
        Key: 'org/o/project/p/git-backups/2026-08-04.bundle',
        Body: body,
        ContentLength: 12,
        ContentType: 'application/x-git-bundle',
        IfNoneMatch: '*',
      },
    });
    expect(client.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('treats a conditional-write race as idempotent and propagates other upload failures', async () => {
    const client = new FakeS3();
    const store = createS3BackupObjectStore({ client, bucket: 'zapp-artifacts', timeoutMs: 3_000 });
    client.error = Object.assign(new Error('precondition failed'), {
      $metadata: { httpStatusCode: 412 },
    });
    await expect(store.put('key', Readable.from('one'), 3)).resolves.toBeUndefined();

    client.error = Object.assign(new Error('storage failed'), {
      $metadata: { httpStatusCode: 500 },
    });
    await expect(store.put('key', Readable.from('two'), 3)).rejects.toBe(client.error);
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
