import {
  createServiceTokenSigner,
  type ServiceAudience,
  type ServiceName,
  type ServiceTokenSigner,
} from '@zapp/config';

import { createInMemoryTokenDenylist, type TokenDenylist } from '../../src/auth/denylist.js';
import {
  createServiceTokenVerifier,
  type ServiceTokenVerifier,
} from '../../src/internal/service-auth.js';
import { SECRET_DECRYPT_AUDIENCE } from '../../src/internal/secrets.js';

/**
 * Real service tokens for the suites, minted by the shipping signer.
 *
 * Deliberately not a fake. The gate, the audience pinning, the expiry, the
 * subject enum and the single-use spend are the whole of CP-8, and a double
 * that answered "yes, that string is sandbox-service" would let every one of
 * them be wrong while the secrets suites stayed green — the same reason
 * `TEST_MASTER_KEY` wraps the real AES-256-GCM rather than a stub. The only
 * thing substituted here is the secret itself and the clock.
 *
 * The consequence is that a caller mints per call, exactly as a real service
 * must: the decrypt route is single-use, so a token presented twice is refused
 * the second time. Tests that need two calls mint twice, which is what
 * `sandbox-service` will do.
 */

/** 32 bytes of nothing, in the shape the config demands. Never a real key. */
export const TEST_SERVICE_TOKEN_SECRET = 'c'.repeat(64);
export const TEST_PREVIOUS_SERVICE_TOKEN_SECRET = 'd'.repeat(64);

export interface TestServiceTokensOptions {
  readonly secret?: string;
  readonly previousSecret?: string;
  /** Shared with the session layer in a real deployment, so shared here too. */
  readonly denylist?: TokenDenylist;
  readonly now?: () => Date;
}

/**
 * A signer and the verifier that answers it, wired to the same secret — what
 * `composeApp` builds, with the clock and the store a test controls.
 */
export class TestServiceTokens {
  readonly verifier: ServiceTokenVerifier;
  private readonly signer: ServiceTokenSigner;
  private readonly now: () => Date;

  constructor(options: TestServiceTokensOptions = {}) {
    const previousSecret = options.previousSecret;
    this.now = options.now ?? ((): Date => new Date());
    this.signer = createServiceTokenSigner({
      secret: options.secret ?? TEST_SERVICE_TOKEN_SECRET,
      ...(previousSecret === undefined ? {} : { previousSecret }),
    });
    this.verifier = createServiceTokenVerifier({
      signer: this.signer,
      denylist: options.denylist ?? createInMemoryTokenDenylist(this.now),
      now: this.now,
    });
  }

  /**
   * Mints a token for `service`, addressed to the decrypt route unless a test
   * says otherwise — that being the only internal route today.
   */
  async issue(
    service: ServiceName,
    options: { aud?: ServiceAudience; ttlSec?: number } = {},
  ): Promise<string> {
    const issued = await this.signer.signServiceToken({
      service,
      aud: options.aud ?? SECRET_DECRYPT_AUDIENCE,
      ...(options.ttlSec === undefined ? {} : { ttlSec: options.ttlSec }),
      now: this.now(),
    });
    return issued.token;
  }
}
