import { createDb } from '@zapp/db';

import { buildApp } from './app.js';
import { loadAuthEnv } from './auth/config.js';
import { createStytchAuthPort } from './auth/stytch.js';
import { createDbUserStore } from './auth/users.js';
import { loadEnv } from './env.js';
import { loggerOptions } from './logging.js';
import { createDbOrganizationStore } from './orgs/store.js';

const env = loadEnv();
// Fails fast and by name: a control plane that cannot verify a session, or does
// not know which database it owns, must not accept the first request.
const auth = loadAuthEnv();
const database = createDb(auth.databaseUrl);

const app = buildApp({
  logger: loggerOptions({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' }),
  auth: {
    port: createStytchAuthPort(auth.stytch),
    users: createDbUserStore(database.db),
    config: auth.config,
  },
  orgs: { organizations: createDbOrganizationStore(database.db) },
});

// The pool is opened here, so it is closed here — `close()` runs every `onClose`
// hook, and this is the hook for the handle this file created.
app.addHook('onClose', async () => {
  await database.close();
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
