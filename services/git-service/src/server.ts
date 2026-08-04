import { createDb } from '@zapp/db';

import { composeApp } from './compose.js';
import { loadDatabaseUrl, loadEnv, loadForgejoEnv, loadServiceTokenConfig } from './env.js';
import { loggerOptions } from './logging.js';

/**
 * The listen entrypoint, and nothing else: read the environment, hand it to
 * {@link composeApp}, serve. Every wiring decision lives in `compose.ts`, where a
 * test can assert it.
 */

const env = loadEnv();
// Fails fast and by name. A git service that cannot reach Forgejo would answer
// every repository create with a 502, and one that cannot verify a service token
// would answer every call with a 401 — both of which read like a bug in the
// caller. Refusing to start says which it is, once, at the right moment.
const forgejo = loadForgejoEnv();
const serviceTokens = loadServiceTokenConfig();
// And cannot record who it handed a repository credential to (GIT-3). A mint
// with no audit row is refused rather than served, so a service that came up
// without a database would refuse every mint — which is a worse way to learn the
// variable is missing than not starting.
const database = createDb(loadDatabaseUrl());

const app = composeApp({
  logger: loggerOptions({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' }),
  forgejo,
  serviceTokens,
  database: database.db,
});

// The handle is opened here, so it is closed here.
app.addHook('onClose', async () => {
  await database.close();
});

/**
 * `close()` stops accepting connections, drains what is in flight, then runs
 * every `onClose` hook — which is where the handle above is released. Teardown
 * therefore stays with whoever created the handle, and this entrypoint does not
 * grow a list.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // `once`: a second signal should kill an already-draining process, not re-enter.
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
