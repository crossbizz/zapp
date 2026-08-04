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
 * which skips visibly until `STYTCH_PROJECT_ID`/`STYTCH_SECRET` hold something
 * that is not `.env.example`'s placeholder. "Not empty" was the gate for a
 * milestone, and `.env.example` ships `STYTCH_SECRET=replace-me` — so the live
 * suite ran, and passed, against a project that does not exist. What made that
 * possible on this side of the seam is fixed below: a failure is now sorted into
 * "Stytch says no" and "Stytch will not talk to us" before it is discarded.
 */

/** The Stytch session the exchange creates. We do not use it; it must still have a lifetime. */
const STYTCH_SESSION_DURATION_MINUTES = 60;

/**
 * Why a call to Stytch did not produce an answer we could use.
 *
 * The distinction this type exists for: **"Stytch says no" and "Stytch will not
 * talk to us" are not the same event**, and for a whole milestone this adapter
 * could not tell them apart. `verifySession` was a bare `catch { return null }`
 * and `exchangeCode` funnelled every failure into `exchange_failed`, so a 401
 * caused by a wrong project id looked exactly like an expired session — which is
 * how `test/integration/auth.test.ts` came to pass against
 * `STYTCH_SECRET=replace-me`. A caller still gets the same outcome (that part is
 * the contract); an operator now gets a different one.
 */
export type StytchFaultKind =
  /** Stytch answered about the *subject*: this token, code or session is not valid. Routine. */
  | 'rejected'
  /** Stytch refused *us*: the project id / secret pair is not one it accepts. Never routine. */
  | 'misconfigured'
  /** No answer at all — DNS, TLS, a timeout, the wrong host. Also never routine. */
  | 'unreachable';

export interface StytchFault {
  readonly kind: StytchFaultKind;
  /** Which port method failed, for the log line. */
  readonly operation: 'exchangeCode' | 'verifySession' | 'createOrganization';
  /** Stytch's `error_type`, when it sent one. */
  readonly errorType?: string;
  readonly statusCode?: number;
  /**
   * Stytch's `request_id`. Two jobs: it is the handle Stytch support asks for,
   * and it is the only proof available to a test that a real round trip
   * happened — nothing local invents one.
   */
  readonly requestId?: string;
}

/**
 * Where a fault goes. Never given the provider's `error_message`: Stytch's error
 * text quotes the request that failed, and the request here carries a one-time
 * code or an API key.
 */
export type StytchFaultReporter = (fault: StytchFault) => void;

/**
 * Stytch's error types for "the credentials you presented are not ones we
 * accept", as opposed to "the thing you asked about is not valid".
 *
 * This set is the one thing in this file taken from documentation rather than
 * from a live response: no credentials existed when it was written (AGENTS.md
 * §10). If Stytch answers bad credentials with some other type, this adapter
 * would classify it as a rejection and the misconfiguration would go quiet
 * again — so `test/integration/auth.test.ts` asserts the type it actually
 * receives, and that assertion is what catches the drift the first time a real
 * project is configured.
 */
const CREDENTIAL_ERROR_TYPES: ReadonlySet<string> = new Set([
  'unauthorized_credentials',
  'invalid_credentials',
  'project_not_found',
]);

/**
 * The shape the SDK's `StytchError` carries. Matched structurally rather than
 * with `instanceof`: `stytch`'s package entry exports `envs` and its client
 * classes, not its error classes, so the response shape is the only stable
 * handle on one.
 */
interface StytchErrorLike {
  readonly status_code: number;
  readonly error_type: string;
  readonly request_id?: string;
}

function asStytchError(error: unknown): StytchErrorLike | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as Partial<StytchErrorLike>;
  return typeof candidate.status_code === 'number' && typeof candidate.error_type === 'string'
    ? (candidate as StytchErrorLike)
    : undefined;
}

/**
 * Sorts a thrown value into one of the three kinds.
 *
 * An error carrying a `status_code` and an `error_type` is Stytch having
 * answered; anything else — a `RequestError`, a fetch `TypeError`, an abort —
 * is Stytch not having answered, which is a fault on our side of the wire even
 * when the cause is theirs.
 */
export function classifyStytchFailure(
  error: unknown,
  operation: StytchFault['operation'],
): StytchFault {
  const answered = asStytchError(error);
  if (answered === undefined) {
    return { kind: 'unreachable', operation };
  }
  return {
    kind: CREDENTIAL_ERROR_TYPES.has(answered.error_type) ? 'misconfigured' : 'rejected',
    operation,
    errorType: answered.error_type,
    statusCode: answered.status_code,
    ...(answered.request_id === undefined ? {} : { requestId: answered.request_id }),
  };
}

/**
 * The default reporter.
 *
 * `rejected` is silent because it is not an incident — it is the answer to the
 * question that was asked, and every sign-in page produces some. The other two
 * are the deployment being wrong about itself, and they go to stderr: the
 * service's pino logger writes to stdout, so this cannot be lost in it, and this
 * adapter is constructed in `src/compose.ts` before any logger exists to inject.
 */
function reportToStderr(fault: StytchFault): void {
  if (fault.kind === 'rejected') {
    return;
  }
  console.error(
    `[auth.stytch] ${fault.kind}: ${fault.operation} — ` +
      `error_type=${fault.errorType ?? 'none'} status=${String(fault.statusCode ?? 0)} ` +
      `request_id=${fault.requestId ?? 'none'}`,
  );
}

export interface StytchAuthPortConfig {
  readonly projectId: string;
  readonly secret: string;
  /** Public (browser-safe) token — the only credential that appears in a redirect URL. */
  readonly publicToken: string;
  /** Discovery provider slug: `google`, `github`, `microsoft`. Defaults to `google`. */
  readonly oauthProvider?: string;
  /**
   * Where classified failures go. Defaults to a stderr line for anything that is
   * not a routine rejection; a test supplies a collector so it can assert *which*
   * kind it got, which is the only way an integration suite can tell a live
   * project from a garbage secret.
   */
  readonly onFault?: StytchFaultReporter;
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
 *
 * The wording a caller sees is unchanged by the classification: a client learns
 * nothing about whether our own credentials are wrong, because that is not a
 * client's business and telling them would be an oracle. The classification goes
 * to `report` instead.
 */
async function guard<T>(
  run: () => Promise<T>,
  name: StytchFault['operation'],
  code: 'exchange_failed' | 'organization_create_failed',
  message: string,
  report: StytchFaultReporter,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AuthPortError) {
      // Our own refusal (`organization_required`, `authentication_incomplete`),
      // raised from inside the operation. Stytch did not fail; nothing to sort.
      throw error;
    }
    report(classifyStytchFailure(error, name));
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
  const report = config.onFault ?? reportToStderr;

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
        'exchangeCode',
        'exchange_failed',
        'Sign-in could not be completed.',
        report,
      );
    },

    async verifySession(token) {
      try {
        const { member_session } = await client.sessions.authenticateJwt({ session_jwt: token });
        return { externalId: member_session.member_id };
      } catch (error) {
        // Still `null`, and still not a throw: an invalid session is an answer,
        // the caller gets a 401 either way, and a provider hiccup must not
        // become a 500 here. `AuthPort.verifySession` promises exactly that.
        //
        // What changed is that the *reason* no longer disappears with the
        // exception. `null` used to mean any of "this session is not valid",
        // "our project id and secret are not accepted" and "Stytch is
        // unreachable", so a deployment with the wrong credentials rejected
        // every session in silence and looked like a deployment nobody was
        // signing in to.
        report(classifyStytchFailure(error, 'verifySession'));
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
        'createOrganization',
        'organization_create_failed',
        'The organization could not be created.',
        report,
      );
    },
  };
}
