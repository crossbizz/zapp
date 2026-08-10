import { NativeConnection, type Worker } from '@temporalio/worker';
import { defineEnv } from '@zapp/config';
import { createDb } from '@zapp/db';
import { z } from 'zod';

import {
  createCapabilityScanObjectClient,
  createProductionCapabilityScanActivities,
} from '../activities/capability-scan-production.js';
import { createProductionCapabilityScanWorker } from '../worker.js';

const CapabilityScanWorkerEnvSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    TEMPORAL_ADDRESS: z.string().trim().min(1),
    SANDBOX_SERVICE_URL: z.string().url(),
    SERVICE_TOKEN_SECRET: z.string().min(32),
    SERVICE_TOKEN_SECRET_PREVIOUS: z.union([z.string().min(32), z.literal('')]).optional(),
    ARTIFACT_ENDPOINT: z.string().url(),
    ARTIFACT_KEY: z.string().min(1),
    ARTIFACT_SECRET: z.string().min(1),
    ARTIFACT_BUCKET: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u),
    ARTIFACT_REGION: z.string().trim().min(1).default('auto'),
  })
  .transform((env) => ({
    databaseUrl: env.DATABASE_URL,
    temporalAddress: env.TEMPORAL_ADDRESS,
    sandboxServiceUrl: env.SANDBOX_SERVICE_URL.replace(/\/+$/u, ''),
    serviceTokens: {
      secret: env.SERVICE_TOKEN_SECRET,
      ...(env.SERVICE_TOKEN_SECRET_PREVIOUS === undefined || env.SERVICE_TOKEN_SECRET_PREVIOUS === ''
        ? {}
        : { previousSecret: env.SERVICE_TOKEN_SECRET_PREVIOUS }),
    },
    artifacts: {
      endpoint: env.ARTIFACT_ENDPOINT.replace(/\/+$/u, ''),
      accessKeyId: env.ARTIFACT_KEY,
      secretAccessKey: env.ARTIFACT_SECRET,
      bucket: env.ARTIFACT_BUCKET,
      region: env.ARTIFACT_REGION,
    },
  }));

export type CapabilityScanWorkerEnv = z.infer<typeof CapabilityScanWorkerEnvSchema>;

export function loadCapabilityScanWorkerEnv(source: unknown = process.env): CapabilityScanWorkerEnv {
  return defineEnv(CapabilityScanWorkerEnvSchema, source);
}

function localEndpoint(endpoint: string): boolean {
  const hostname = new URL(endpoint).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === 'minio';
}

export async function runCapabilityScanWorker(
  config: CapabilityScanWorkerEnv = loadCapabilityScanWorkerEnv(),
): Promise<void> {
  const database = createDb(config.databaseUrl);
  const connection = await NativeConnection.connect({ address: config.temporalAddress });
  const objectClient = createCapabilityScanObjectClient({
    endpoint: config.artifacts.endpoint,
    region: config.artifacts.region,
    maxAttempts: 3,
    credentials: {
      accessKeyId: config.artifacts.accessKeyId,
      secretAccessKey: config.artifacts.secretAccessKey,
    },
    forcePathStyle: localEndpoint(config.artifacts.endpoint),
  });
  let worker: Worker | undefined;
  try {
    worker = await createProductionCapabilityScanWorker({
      connection,
      database: database.db,
      activities: createProductionCapabilityScanActivities({
        sandbox: {
          baseUrl: config.sandboxServiceUrl,
          serviceTokens: config.serviceTokens,
        },
        artifacts: {
          client: objectClient,
          bucket: config.artifacts.bucket,
        },
      }),
    });
    await worker.run();
  } finally {
    objectClient.destroy();
    await connection.close();
    await database.close();
  }
}
