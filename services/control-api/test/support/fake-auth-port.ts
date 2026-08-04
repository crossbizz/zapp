import type { AuthIdentity, AuthPort } from '../../src/auth/port.js';
import { AuthPortError } from '../../src/auth/port.js';

/**
 * The identity provider, minus the provider. Every session and route test in
 * this service runs against this: the Stytch adapter's own behaviour is pinned
 * separately (`test/stytch.test.ts` for request shaping, `test/integration` for
 * the live API), so nothing here needs credentials, a network, or a clock.
 *
 * It records what it was asked as well as answering, because half of what the
 * login route has to get right — the redirect URI it registers, the state it
 * signs — is only observable in the call, not in the response.
 */
export class FakeAuthPort implements AuthPort {
  /** `code` → the identity `exchangeCode` will return for it. */
  readonly identities = new Map<string, AuthIdentity>();
  /** Provider session token → external id, for {@link verifySession}. */
  readonly providerSessions = new Map<string, string>();
  readonly authorizationRequests: { redirectUri: string; state: string }[] = [];
  readonly createdOrganizations: { name: string; slug: string }[] = [];
  /**
   * Makes {@link createOrganization} refuse. The call is still recorded, so a
   * test can prove the attempt happened *and* that nothing survived it.
   */
  organizationCreateFails = false;

  /** Registers `identity` under `code` and hands the code back. */
  issueCode(code: string, identity: AuthIdentity): string {
    this.identities.set(code, identity);
    return code;
  }

  getAuthorizationUrl(input: { redirectUri: string; state: string }): string {
    this.authorizationRequests.push(input);
    const url = new URL('https://idp.fake.test/authorize');
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  exchangeCode(code: string): Promise<AuthIdentity> {
    const identity = this.identities.get(code);
    if (identity === undefined) {
      return Promise.reject(new AuthPortError('exchange_failed', 'unknown authorization code'));
    }
    return Promise.resolve(identity);
  }

  verifySession(token: string): Promise<{ externalId: string } | null> {
    const externalId = this.providerSessions.get(token);
    return Promise.resolve(externalId === undefined ? null : { externalId });
  }

  createOrganization(input: { name: string; slug: string }): Promise<{ externalOrgId: string }> {
    this.createdOrganizations.push(input);
    if (this.organizationCreateFails) {
      return Promise.reject(
        new AuthPortError('organization_create_failed', 'the provider refused the organization'),
      );
    }
    return Promise.resolve({ externalOrgId: `organization-test-${input.slug}` });
  }
}
