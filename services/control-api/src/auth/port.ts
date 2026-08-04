/**
 * The identity provider, as the rest of this service is allowed to see it.
 *
 * Stytch is a locked decision (master plan §2), not a hidden one: everything
 * below `src/auth/stytch.ts` speaks Stytch, and everything above speaks this.
 * The reason is testability rather than portability — routes, sessions, the
 * device flow and the CSRF rules are all exercised against a fake that needs no
 * credentials, and CP-3 gets a seam for organization creation it can drive.
 *
 * zapp's own tables stay the source of truth for membership (PRD §22.1); what
 * comes back from here is only ever an *identity*, never an authorization.
 */

/** Who the provider says the person is. Nothing here is trusted for access control. */
export interface AuthIdentity {
  /** Stable provider-side id — a Stytch `member_id`. Opaque to us. */
  readonly externalId: string;
  readonly email: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
}

/**
 * Why a provider call could not produce an identity. These are the only failures
 * a caller may branch on; anything else is a bug and becomes a 500.
 */
export type AuthPortErrorCode =
  /** The code was never issued, has expired, or the provider rejected it. */
  | 'exchange_failed'
  /** The person authenticated, but belongs to no organization to sign in to (CP-3 owns the fix). */
  | 'organization_required'
  /** The provider wants another factor before it will call this a session. */
  | 'authentication_incomplete'
  /** The provider refused to create the organization. */
  | 'organization_create_failed';

/**
 * A failure that is safe to surface. The message is ours, never the provider's:
 * upstream error text routinely quotes the request, and the request here is a
 * secret (an authorization code, an API key).
 */
export class AuthPortError extends Error {
  readonly code: AuthPortErrorCode;

  constructor(code: AuthPortErrorCode, message: string) {
    super(message);
    this.name = 'AuthPortError';
    this.code = code;
  }
}

export interface AuthPort {
  /**
   * Where to send a browser to sign in. `state` is opaque to the provider and
   * must come back untouched — the callback refuses to proceed without it.
   */
  getAuthorizationUrl(input: { redirectUri: string; state: string }): string;
  /** Turns the provider's one-time code into an identity. @throws {AuthPortError} */
  exchangeCode(code: string): Promise<AuthIdentity>;
  /** Validates a *provider-issued* session token. `null` means "not valid", not "error". */
  verifySession(token: string): Promise<{ externalId: string } | null>;
  /**
   * Mirrors a zapp organization into the provider — one Stytch Organization per
   * zapp org (plan 02 architecture). Defined here so CP-3 can call it the day it
   * lands rather than reaching for the SDK directly. @throws {AuthPortError}
   */
  createOrganization(input: { name: string; slug: string }): Promise<{ externalOrgId: string }>;
}
