import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import type { Database } from '@zapp/db';

import { buildApp, type AppInstance } from './app.js';
import { createDbGitAuditSink } from './audit.js';
import type { ForgejoEnv } from './env.js';
import { createForgejoClient } from './forgejo/client.js';
import type { LoggerConfig } from './logging.js';
import { createForgejoGitProvider } from './provider/forgejo.js';
import { createRepositoryFeatures } from './provider/repository-features.js';
import { createRepositoryOperations } from './provider/repository-operations.js';
import type { ApprovedTemplateRegistry } from './template-registry.js';
import { parseInternalRepoRef } from '@zapp/contracts';
import { createGitMirror } from './import/mirror.js';
import { createTokenService, type TokenService } from './tokens.js';
import { createGitBundleCommands } from './backup.js';
import { createGitBundleExporter, createTokenServiceGitBundleCredentials } from './export.js';

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
  /**
   * Where the `audit_events` rows go (GIT-3).
   *
   * Required rather than optional, for the reason CP-7 makes the vault's master
   * key required: a git service that came up unable to write an audit row would
   * discover it at the first token mint — by refusing it, since a credential
   * handed out with no record of it is the outcome the trail exists to prevent.
   * Refusing to start says so once, at the right moment.
   */
  readonly database: Database;
  /** Server-approved, exact-SHA template sources loaded from checked-in config. */
  readonly templateRegistry: ApprovedTemplateRegistry;
  /** Omitted in production, where the app's own defaults apply. `false` in tests. */
  readonly logger?: LoggerConfig;
  /** Bounded Git subprocess deadline for an on-demand portable bundle. */
  readonly gitBundleCommandTimeoutMs?: number;
}

/**
 * What the deployment gets back.
 *
 * An object rather than the app alone — which is where the control plane's
 * `composeApp` stops — because this service has one thing to do that is not a
 * request: expiring tokens (`src/sweep.ts`). The entrypoint needs the same token
 * service the routes are bound to, and handing it back here is how it gets one
 * without `server.ts` constructing a second Forgejo client and a second binding
 * that could differ from the first.
 */
export interface ServiceComposition {
  readonly app: AppInstance;
  /** Bound to the same Forgejo client the routes use. `server.ts` sweeps with it. */
  readonly tokens: TokenService;
}

export function composeApp(runtime: ServiceRuntime): ServiceComposition {
  // One client for both bindings: the provider and the token service act on the
  // same instance with the same admin credential and the same deadline, and two
  // clients would be two places for those to drift apart.
  const client = createForgejoClient(runtime.forgejo);
  // One token service, bound to the routes *and* handed to the sweep. Two would
  // be two Forgejo clients and two chances for them to disagree about which
  // instance, which credential and which deadline.
  const tokens = createTokenService({ client, audit: createDbGitAuditSink(runtime.database) });
  const provider = createForgejoGitProvider({ client });
  const importProvider = Object.assign(provider, {
    async setDefaultBranch(ref: string, branch: string): Promise<void> {
      const { owner, name } = parseInternalRepoRef(ref);
      await client.send({
        method: 'PATCH',
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        body: { default_branch: branch },
      });
    },
  });
  const bundleExporter = createGitBundleExporter({
    credentials: createTokenServiceGitBundleCredentials(tokens),
    commands: ({ username, token }) =>
      createGitBundleCommands({
        username,
        password: token,
        timeoutMs: runtime.gitBundleCommandTimeoutMs ?? 240_000,
      }),
  });
  const repositoryFeatures = createRepositoryFeatures({
    registry: runtime.templateRegistry,
    tokens,
    operations: createRepositoryOperations(),
    headReader: provider,
  });

  const app = buildApp({
    ...(runtime.logger === undefined ? {} : { logger: runtime.logger }),
    // Named here rather than left to a default, because this file is where a
    // port's shipping binding is supposed to be legible: Forgejo, reached
    // through the one client that gives every call a deadline and keeps the
    // admin token out of every error it raises.
    provider: importProvider,
    tokens,
    repositoryFeatures,
    signer: createServiceTokenSigner(runtime.serviceTokens),
    mirror: createGitMirror(),
    bundleExporter,
  });

  return { app, tokens };
}
