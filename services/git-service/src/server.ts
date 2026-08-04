import { composeApp } from './compose.js';
import { loadEnv, loadForgejoEnv, loadServiceTokenConfig } from './env.js';
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

const app = composeApp({
  logger: loggerOptions({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' }),
  forgejo,
  serviceTokens,
});

/**
 * `close()` stops accepting connections, drains what is in flight, then runs
 * every `onClose` hook. This service opens no pool and no cache, so there is
 * nothing else to release — and the day it does, the release belongs in the
 * plugin that opened it rather than in a list here.
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
