import type { ServiceIdentity, ServiceTokenVerifier } from '../../src/internal/service-auth.js';

/**
 * A `ServiceTokenVerifier` with a Map behind it.
 *
 * CP-8 ships the HMAC verifier; what CP-7 needs from it is only the *shape* —
 * "this string names this service, or it names nobody" — so the suites exercise
 * the real `requireService` gate, the real allowlist and the real audit path
 * against a token store a test controls. A token nobody issued verifies as
 * `undefined`, which is what an expired or forged one will do too.
 */
export class FakeServiceTokens implements ServiceTokenVerifier {
  private readonly tokens = new Map<string, ServiceIdentity>();

  /** Mints `token` for `service`, and returns it so a caller can send it. */
  issue(service: string, token = `token-${service}`): string {
    this.tokens.set(token, { service, tokenId: `tok_${service}` });
    return token;
  }

  verify(token: string): Promise<ServiceIdentity | undefined> {
    return Promise.resolve(this.tokens.get(token));
  }
}
