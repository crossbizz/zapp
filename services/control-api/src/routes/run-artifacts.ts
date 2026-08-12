import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { ApiError } from '../errors.js';

export const MAX_PUBLIC_RUN_ARTIFACT_BYTES = 64 * 1024;

export interface RunArtifactReaderPort {
  read(input: {
    readonly key: string;
    readonly maxBytes: number;
  }): Promise<
    | { readonly body: Buffer; readonly contentType: string }
    | 'too_large'
    | undefined
  >;
}

export function createS3RunArtifactReader(config: {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}): RunArtifactReaderPort {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return {
    async read(input) {
      try {
        const result = await client.send(new GetObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          // Reading one sentinel byte past the public ceiling keeps the memory
          // boundary structural even when object metadata is stale or absent.
          Range: `bytes=0-${String(input.maxBytes)}`,
        }));
        if (result.Body === undefined) return undefined;
        const body = Buffer.from(await result.Body.transformToByteArray());
        if (body.length > input.maxBytes) return 'too_large';
        return {
          body,
          contentType: result.ContentType ?? 'application/octet-stream',
        };
      } catch (error) {
        if (
          typeof error === 'object' && error !== null && 'name' in error &&
          ['NoSuchKey', 'NotFound'].includes(String((error as { name?: unknown }).name))
        ) return undefined;
        throw error;
      }
    },
  };
}

export function createUnavailableRunArtifactReader(): RunArtifactReaderPort {
  return {
    read: () => Promise.reject(
      new ApiError(
        'run_artifact_storage_unavailable',
        503,
        'Run artifact storage is unavailable.',
      ),
    ),
  };
}
