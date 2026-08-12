import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import type { Database } from '@zapp/db';

import { buildApp, type LoggerConfig } from './app.js';
import {
  createReleaseLifecycleService,
  type ReleaseLifecycleDependencies,
} from './lifecycle.js';
import {
  createPostgresReleaseContext,
  createPostgresReleaseStore,
  createReleaseRecordService,
  type ReleaseContextPort,
  type ReleaseGitPort,
} from './release/create.js';

export interface ReleaseServiceRuntime {
  readonly database: Database;
  readonly serviceTokens: ServiceTokenConfig;
  readonly git: ReleaseGitPort;
  readonly context?: ReleaseContextPort;
  readonly lifecycle: Omit<ReleaseLifecycleDependencies, 'records'>;
  readonly now?: () => Date;
  readonly logger?: LoggerConfig;
}

/** Shipping composition: durable records plus the provider/state-machine adapters. */
export function composeApp(runtime: ReleaseServiceRuntime) {
  const records = createReleaseRecordService({
    store: createPostgresReleaseStore(runtime.database),
    context: runtime.context ?? createPostgresReleaseContext(runtime.database),
    git: runtime.git,
    ...(runtime.now === undefined ? {} : { now: runtime.now }),
  });
  const lifecycle = createReleaseLifecycleService({ records, ...runtime.lifecycle });
  return buildApp({
    records,
    lifecycle,
    signer: createServiceTokenSigner(runtime.serviceTokens),
    ...(runtime.now === undefined ? {} : { now: runtime.now }),
    ...(runtime.logger === undefined ? {} : { logger: runtime.logger }),
  });
}
