import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';

import { buildApp, type AppInstance } from './app.js';
import type { ForgejoEnv } from './env.js';
import { createForgejoClient } from './forgejo/client.js';
import type { LoggerConfig } from './logging.js';
import { createForgejoGitProvider } from './provider/forgejo.js';

/**
 * The composition the deployed service runs — every port bound to its shipping
 * implementation, in one place.
 *
 * Separate from `server.ts` for the reason the control plane's is
 * (`services/control-api/src/compose.ts`): `server.ts` reads the environment,
 * opens handles and listens, and none of those three can be exercised by a test.
 * While the composition lived alongside them, "the deployed app serves the
 * routes it is supposed to" was a claim nothing checked — and in the control
 * plane that turned out to be false for a whole task.
 * `test/compose.test.ts` asserts this function's output serves `/internal/git/*`
 * and refuses an unauthenticated call to it.
 */
export interface ServiceRuntime {
  readonly forgejo: ForgejoEnv;
  /**
   * The secret this service verifies inbound service tokens against, from
   * `loadServiceTokenConfig`. Required: with no secret there is no way to tell a
   * zapp service from anybody else, and this service holds the one credential
   * with administrative reach over every tenant's source code.
   */
  readonly serviceTokens: ServiceTokenConfig;
  /** Omitted in production, where the app's own defaults apply. `false` in tests. */
  readonly logger?: LoggerConfig;
}

export function composeApp(runtime: ServiceRuntime): AppInstance {
  return buildApp({
    ...(runtime.logger === undefined ? {} : { logger: runtime.logger }),
    // Named here rather than left to a default, because this file is where a
    // port's shipping binding is supposed to be legible: Forgejo, reached
    // through the one client that gives every call a deadline and keeps the
    // admin token out of every error it raises.
    provider: createForgejoGitProvider({ client: createForgejoClient(runtime.forgejo) }),
    signer: createServiceTokenSigner(runtime.serviceTokens),
  });
}
