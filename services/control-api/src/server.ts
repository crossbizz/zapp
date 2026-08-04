import { createDb } from '@zapp/db';

import { loadAuthEnv } from './auth/config.js';
import { composeApp } from './compose.js';
import { loadRateLimitSettings } from './config/rate-limits.js';
import { loadEnv, loadMasterKey, loadRedisUrl } from './env.js';
import { loggerOptions } from './logging.js';
import { createRedisConnection } from './redis/client.js';

/**
 * The listen entrypoint, and nothing else: read the environment, open the
 * handles, hand them to {@link composeApp}, serve. Every wiring decision lives
 * in `compose.ts`, where a test can assert it.
 */

const env = loadEnv();
// Fails fast and by name: a control plane that cannot verify a session, does
// not know which database it owns, cannot reach the store holding its revoked
// sessions, or has no limits configured must not accept the first request.
const auth = loadAuthEnv();
const redisUrl = loadRedisUrl();
const rateLimits = loadRateLimitSettings();
// And cannot open its own vault. A service that came up without the master key
// would serve every secrets route as a 500 at the first write, which is a worse
// way to learn the key is missing than not starting.
const masterKey = loadMasterKey();

const database = createDb(auth.databaseUrl);
// The app does not exist yet, and a connection error can arrive at any time
// after this line. Routed through a mutable sink so it reaches the same logger
// as everything else rather than a bare `console`.
let logRedisError: (error: Error) => void = () => {};
const redis = createRedisConnection(redisUrl, {
  onError: (error) => {
    logRedisError(error);
  },
});

const app = composeApp({
  logger: loggerOptions({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' }),
  database: database.db,
  redis,
  auth,
  masterKey,
  rateLimits,
});

logRedisError = (error) => {
  // Not fatal: the rate limiter fails open for reads and closed for auth by
  // configuration, and the session layer reports its own failures per request.
  app.log.error({ err: error }, 'redis connection error');
};

// The handles are opened here, so they are closed here — `close()` runs every
// `onClose` hook, and these are the hooks for the handles this file created.
app.addHook('onClose', async () => {
  await database.close();
  await redis.close();
});

/**
 * `close()` stops accepting connections, drains what is in flight, then runs every
 * `onClose` hook — which is where a plugin releases the handle it opened (the database
 * pool, the Redis client). Teardown therefore stays with whoever created the handle,
 * and this entrypoint does not grow a list.
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
