import { B2BClient, envs } from 'stytch';

import { AuthPortError, type AuthIdentity, type AuthPort } from './port.js';

/**
 * The Stytch B2B implementation of {@link AuthPort} (master plan §2 — Stytch is
 * a locked decision).
 *
 * Sign-in is Stytch's **discovery** flow: the browser authenticates first and
 * the organization is chosen afterwards, which is the only shape that works
 * when a person may belong to several zapp organizations. What comes back is
 * mapped to an identity and nothing else — Stytch's own session is not what
 * authenticates later requests (`src/auth/session.ts` mints ours), and Stytch
 * membership is not what authorizes them (PRD §22.1: zapp's tables are).
 *
 * NOTE: no live credentials existed while this was written (M1 in AGENTS.md
 * §10), so the request shaping below is pinned by `test/stytch.test.ts` against
 * the SDK's own types, and the round trip by `test/integration/auth.test.ts`,
 * which skips visibly until `STYTCH_PROJECT_ID`/`STYTCH_SECRET` are present.
 */

/** The Stytch session the exchange creates. We do not use it; it must still have a lifetime. */
const STYTCH_SESSION_DURATION_MINUTES = 60;

export interface StytchAuthPortConfig {
  readonly projectId: string;
  readonly secret: string;
  /** Public (browser-safe) token — the only credential that appears in a redirect URL. */
  readonly publicToken: string;
  /** Discovery provider slug: `google`, `github`, `microsoft`. Defaults to `google`. */
  readonly oauthProvider?: string;
}

/** The slice of the B2B client this adapter touches, so a test can supply a double. */
export type StytchClientLike = Pick<
  B2BClient,
  'oauth' | 'discovery' | 'sessions' | 'organizations'
>;

/** Loose by design: a response only has to carry these fields to be mappable. */
interface MemberLike {
  readonly member_id: string;
  readonly email_address: string;
  readonly name?: string;
  readonly oauth_registrations?: readonly { readonly profile_picture_url?: string }[];
}

interface DiscoveredLike {
  readonly member_authenticated: boolean;
  readonly organization?: { readonly organization_id: string };
}

/**
 * Turns any provider failure into an `AuthPortError` with *our* wording. Stytch
 * error text quotes the request that failed, and the request here carries a
 * one-time code or an API key — none of which may reach a client or a log line.
 */
async function guard<T>(
  operation: () => Promise<T>,
  code: 'exchange_failed' | 'organization_create_failed',
  message: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AuthPortError) {
      throw error;
    }
    throw new AuthPortError(code, message);
  }
}

/**
 * The organization to sign in to: one the member is already authenticated for
 * if there is one, otherwise the first they are eligible to join. Anything more
 * opinionated — remembering a choice, prompting for one — is CP-3's, which owns
 * organization selection and creation.
 */
function pickOrganization(discovered: readonly DiscoveredLike[]): string | undefined {
  const authenticated = discovered.find(
    (entry) => entry.member_authenticated && entry.organization !== undefined,
  );
  const fallback = discovered.find((entry) => entry.organization !== undefined);
  return (authenticated ?? fallback)?.organization?.organization_id;
}

function toIdentity(member: MemberLike): AuthIdentity {
  const avatarUrl = member.oauth_registrations?.find(
    (registration) =>
      registration.profile_picture_url !== undefined && registration.profile_picture_url !== '',
  )?.profile_picture_url;
  const displayName = member.name?.trim();

  return {
    externalId: member.member_id,
    email: member.email_address,
    // A member who signed in with a magic link has no name yet; their address
    // is the only human-readable thing we are entitled to show.
    displayName:
      displayName === undefined || displayName === '' ? member.email_address : displayName,
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
  };
}

/**
 * @param client injected by tests; production builds one from `config`. Stytch
 * picks its own host from the project id prefix, and so does
 * {@link getAuthorizationUrl}, which has to build a browser URL by hand.
 */
export function createStytchAuthPort(
  config: StytchAuthPortConfig,
  client: StytchClientLike = new B2BClient({
    project_id: config.projectId,
    secret: config.secret,
  }),
): AuthPort {
  const baseUrl = config.projectId.startsWith('project-live-') ? envs.live : envs.test;
  const provider = config.oauthProvider ?? 'google';

  return {
    getAuthorizationUrl({ redirectUri, state }) {
      // Stytch's discovery start is a browser endpoint, not an SDK call, and it
      // has no `state` parameter of its own: it appends `token` and
      // `stytch_token_type` to whatever redirect URL it is given. So our state
      // rides on that URL. If it ever fails to come back, the callback sees no
      // state and fails closed — which is the direction an unverifiable
      // handshake has to fail in.
      const redirect = new URL(redirectUri);
      redirect.searchParams.set('state', state);

      const url = new URL(`v1/b2b/public/oauth/${provider}/discovery/start`, baseUrl);
      url.searchParams.set('public_token', config.publicToken);
      url.searchParams.set('discovery_redirect_url', redirect.toString());
      return url.toString();
    },

    exchangeCode(code) {
      return guard(
        async () => {
          const discovery = await client.oauth.discovery.authenticate({
            discovery_oauth_token: code,
          });

          const organizationId = pickOrganization(discovery.discovered_organizations);
          if (organizationId === undefined) {
            throw new AuthPortError(
              'organization_required',
              'This account does not belong to an organization yet.',
            );
          }

          const exchanged = await client.discovery.intermediateSessions.exchange({
            intermediate_session_token: discovery.intermediate_session_token,
            organization_id: organizationId,
            session_duration_minutes: STYTCH_SESSION_DURATION_MINUTES,
          });

          // `member_authenticated: false` means Stytch wants a second factor.
          // Treating it as success would hand out a zapp session on the
          // strength of a first factor alone.
          if (!exchanged.member_authenticated) {
            throw new AuthPortError(
              'authentication_incomplete',
              'Sign-in needs another verification step.',
            );
          }
          return toIdentity(exchanged.member);
        },
        'exchange_failed',
        'Sign-in could not be completed.',
      );
    },

    async verifySession(token) {
      try {
        const { member_session } = await client.sessions.authenticateJwt({ session_jwt: token });
        return { externalId: member_session.member_id };
      } catch {
        // An invalid session is an answer, not an incident: the caller gets a
        // 401 either way, and a provider hiccup must not become a 500 here.
        return null;
      }
    },

    createOrganization({ name, slug }) {
      return guard(
        async () => {
          const created = await client.organizations.create({
            organization_name: name,
            organization_slug: slug,
          });
          return { externalOrgId: created.organization.organization_id };
        },
        'organization_create_failed',
        'The organization could not be created.',
      );
    },
  };
}
