import type { FastifyReply } from 'fastify';
import { ModelIdentifierSchema } from '@zapp/contracts';
import { z } from 'zod';
import type { ProductAnalytics } from '@zapp/config';

import type { AppInstance } from '../app.js';
import type { AuthConfig } from '../auth/config.js';
import {
  AUTH_PATH,
  CSRF_COOKIE,
  OAUTH_STATE_COOKIE,
  REFRESH_COOKIE,
  ROOT_PATH,
  SESSION_COOKIE,
  expireCookie,
  parseCookies,
  serializeCookie,
} from '../auth/cookies.js';
import { sessionFamilyKey, type TokenDenylist } from '../auth/denylist.js';
import { DEVICE_POLL_INTERVAL_SECONDS, type DeviceStore } from '../auth/device.js';
import { AuthPortError, type AuthPort } from '../auth/port.js';
import {
  ACCESS_TOKEN_TTL_MS,
  LOGIN_STATE_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  constantTimeEquals,
  randomToken,
  type SessionSigner,
  type SessionTokens,
} from '../auth/session.js';
import type { UserStore } from '../auth/users.js';
import { ApiError } from '../errors.js';
import { assertCsrf, carriesAuthCookie } from '../plugins/auth.js';

/**
 * PRD §32 `/v1/auth/*` and `/v1/me`.
 *
 * The browser leg (`/login` → provider → `/callback`) ends with three cookies
 * and a redirect. The desktop leg is deliberately *not* a continuation of it: a
 * device grant is only ever bound to a user by an explicit, authenticated,
 * CSRF-protected `POST /v1/auth/device/approve`. Both legs mint the same
 * session, so everything downstream — `/v1/me` today, every tenant route from
 * CP-4 — has one kind of credential to understand.
 */

const seconds = (milliseconds: number): number => Math.floor(milliseconds / 1000);

/** Enough to be unambiguous, narrow enough that a junk value never reaches the store. */
const UserCodeSchema = z.string().regex(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);

const TokenResponseSchema = z.object({
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  /** Omitted when the tokens went into cookies instead — a browser must not read them. */
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
});

const OptionalRefreshTokenBodySchema = z
  .object({ refreshToken: z.string().min(1).optional() })
  .strict()
  .nullable()
  .default({});

const MeResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  memberships: z.array(
    z.object({
      allowedModels: z.array(ModelIdentifierSchema),
      organization: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
      role: z.enum(['owner', 'builder', 'viewer']),
      status: z.enum(['invited', 'active', 'removed']),
    }),
  ),
});

/**
 * Shape follows RFC 8628's device authorization grant; the spelling follows the
 * rest of this API. The only client is our own SDK, and a camelCase field it
 * can share with every other response is worth more than wire-compatibility
 * with a generic OAuth client we do not have.
 */
const DeviceGrantResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  verificationUriComplete: z.string(),
  expiresIn: z.number().int().positive(),
  /** Seconds the client must wait between polls. */
  interval: z.number().int().positive(),
});

const DeviceDecisionSchema = z.object({ userCode: UserCodeSchema });

/** What Stytch calls a discovery-OAuth redirect. Anything else is not our flow. */
const DISCOVERY_TOKEN_TYPE = 'discovery_oauth';

export interface AuthRoutesDeps {
  readonly port: AuthPort;
  readonly users: UserStore;
  readonly config: AuthConfig;
  readonly signer: SessionSigner;
  readonly denylist: TokenDenylist;
  readonly deviceStore: DeviceStore;
  readonly now: () => Date;
  readonly productAnalytics?: ProductAnalytics;
}

/** Fastify accumulates repeated `set-cookie` headers into one array. */
function setCookies(reply: FastifyReply, cookies: string[]): void {
  for (const cookie of cookies) {
    reply.header('set-cookie', cookie);
  }
}

/**
 * Nothing that carries a credential may be kept by a cache, a proxy, or the
 * browser's back/forward store.
 */
function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}

/**
 * The session cookie lives at the root because every request needs it; the
 * refresh cookie is scoped to `/v1/auth`, so the long-lived credential is not
 * attached to hundreds of requests that have no use for it. The CSRF cookie
 * outlives the session deliberately — it has to still be there for the refresh
 * that follows an expired session, or a browser could never renew one.
 */
function sessionCookies(tokens: SessionTokens, csrfToken: string): string[] {
  return [
    serializeCookie(SESSION_COOKIE, tokens.access.token, {
      path: ROOT_PATH,
      maxAgeSeconds: seconds(ACCESS_TOKEN_TTL_MS),
    }),
    serializeCookie(REFRESH_COOKIE, tokens.refresh.token, {
      path: AUTH_PATH,
      maxAgeSeconds: seconds(REFRESH_TOKEN_TTL_MS),
    }),
    serializeCookie(CSRF_COOKIE, csrfToken, {
      path: ROOT_PATH,
      maxAgeSeconds: seconds(REFRESH_TOKEN_TTL_MS),
      httpOnly: false,
    }),
  ];
}

function clearedCookies(): string[] {
  return [
    expireCookie(SESSION_COOKIE, { path: ROOT_PATH }),
    expireCookie(REFRESH_COOKIE, { path: AUTH_PATH }),
    expireCookie(CSRF_COOKIE, { path: ROOT_PATH, httpOnly: false }),
  ];
}

/** Every way a login handshake can fail says the same thing. */
function invalidState(): ApiError {
  return new ApiError('invalid_state', 400, 'The sign-in request could not be verified.');
}

export function registerAuthRoutes(app: AppInstance, deps: AuthRoutesDeps): void {
  const { port, users, config, signer, denylist, deviceStore, now } = deps;
  const callbackUri = `${config.apiBaseUrl}/v1/auth/callback`;
  const verificationUri = `${config.apiBaseUrl}/v1/auth/login`;

  /**
   * How long a revoked login stays revoked: as long as the longest-lived token
   * that could still be presented for it. Reached from the access-token side we
   * cannot know the refresh token's expiry, so we take the upper bound.
   */
  const familyExpiry = (): Date => new Date(now().getTime() + REFRESH_TOKEN_TTL_MS);

  app.get(
    '/v1/auth/login',
    { schema: { querystring: z.object({ userCode: UserCodeSchema.optional() }) } },
    async (request, reply) => {
      const nonce = randomToken();
      const state = await signer.mintLoginState({
        nonce,
        ...(request.query.userCode === undefined ? {} : { userCode: request.query.userCode }),
        now: now(),
      });

      // The nonce stays in the cookie and the state stays in the URL. An
      // attacker who can start a login cannot make someone else's browser
      // finish it, because they cannot write this cookie.
      setCookies(reply, [
        serializeCookie(OAUTH_STATE_COOKIE, nonce, {
          path: AUTH_PATH,
          maxAgeSeconds: seconds(LOGIN_STATE_TTL_MS),
        }),
      ]);
      return reply.redirect(port.getAuthorizationUrl({ redirectUri: callbackUri, state }), 302);
    },
  );

  app.get(
    '/v1/auth/callback',
    {
      schema: {
        querystring: z.object({
          /** Our own name for it… */
          code: z.string().min(1).optional(),
          /** …and Stytch's, which is what actually arrives from a discovery redirect. */
          token: z.string().min(1).optional(),
          stytch_token_type: z.string().min(1).optional(),
          state: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const state = await signer.verifyLoginState(request.query.state, now());
      const nonce = parseCookies(request.headers.cookie).get(OAUTH_STATE_COOKIE) ?? '';
      if (state === null || nonce === '' || !constantTimeEquals(state.nonce, nonce)) {
        throw invalidState();
      }

      // Stytch sends several token types to a project's callback (SSO, magic
      // links, discovery). Only one of them can be exchanged by the call
      // `AuthPort.exchangeCode` makes, so anything else fails closed here
      // rather than being handed to the wrong endpoint.
      const tokenType = request.query.stytch_token_type;
      if (tokenType !== undefined && tokenType !== DISCOVERY_TOKEN_TYPE) {
        throw invalidState();
      }

      const code = request.query.code ?? request.query.token;
      if (code === undefined) {
        throw invalidState();
      }

      const identity = await port.exchangeCode(code).catch((error: unknown) => {
        if (error instanceof AuthPortError && error.code === 'organization_required') {
          throw new ApiError('organization_required', 403, error.message);
        }
        // Anything else the provider refused is, from here, one thing: this
        // person is not signed in. The reason stays in the log.
        request.log.info(
          { errorCode: error instanceof AuthPortError ? error.code : 'unknown' },
          'code exchange failed',
        );
        throw new ApiError('authentication_failed', 401, 'Sign-in could not be completed.');
      });

      const { user, created } = await users.upsertFromIdentity(identity, now());
      if (created && deps.productAnalytics !== undefined) {
        await deps.productAnalytics.capture({
          eventId: `signup:${user.id}`,
          distinctId: user.id,
          event: 'signup',
          properties: {},
        });
      }
      const tokens = await signer.mintSession({ userId: user.id, now: now() });

      noStore(reply);
      setCookies(reply, [
        ...sessionCookies(tokens, randomToken()),
        expireCookie(OAUTH_STATE_COOKIE, { path: AUTH_PATH }),
      ]);

      // A device grant is NOT approved here. Signing in and handing a separate
      // machine a 30-day credential are different decisions, and a callback
      // that conflated them would let anyone who can send a link harvest the
      // session of whoever clicks it — for someone already signed in the whole
      // browser leg is silent, so there would be nothing to notice. The browser
      // goes to the approval screen instead, which shows the code.
      const destination =
        state.userCode === undefined
          ? config.appBaseUrl
          : `${config.appBaseUrl}/device?userCode=${encodeURIComponent(state.userCode)}`;
      return reply.redirect(destination, 302);
    },
  );

  app.get(
    '/v1/me',
    { preHandler: [app.requireSession], schema: { response: { 200: MeResponseSchema } } },
    async (request) => {
      // `request.auth` is set by `requireSession`, which 401s otherwise.
      const auth = request.auth;
      const profile = auth === undefined ? undefined : await users.profile(auth.userId);
      if (profile === undefined) {
        // The token is valid but the user behind it is gone: a session cannot
        // outlive its subject.
        throw new ApiError('unauthenticated', 401, 'Authentication is required.');
      }
      return MeResponseSchema.parse({ user: profile.user, memberships: profile.memberships });
    },
  );

  app.post(
    '/v1/auth/logout',
    {
      // `resolveSession`, not `requireSession`: logging out must never fail
      // closed. A caller whose access token has already expired still needs the
      // refresh token revoked and the cookies cleared, and a 401 would leave a
      // live 30-day credential in the field.
      preHandler: [app.resolveSession, app.requireCsrf],
      schema: {
        body: OptionalRefreshTokenBodySchema,
        response: { 204: z.void() },
      },
    },
    async (request, reply) => {
      const auth = request.auth;
      if (auth !== undefined) {
        await denylist.deny(auth.jti, auth.expiresAt);
        await denylist.deny(sessionFamilyKey(auth.sessionId), familyExpiry());
      }

      // From the cookie for a browser, from the body for the desktop app: a
      // bearer client cannot send our host-only cookie, and its refresh token
      // is the one that matters most.
      const refresh =
        request.body?.refreshToken ?? parseCookies(request.headers.cookie).get(REFRESH_COOKIE);
      const claims = refresh === undefined ? null : await signer.verifyRefresh(refresh, now());
      if (claims !== null) {
        await denylist.deny(claims.jti, claims.expiresAt);
        await denylist.deny(sessionFamilyKey(claims.sessionId), claims.expiresAt);
      }

      noStore(reply);
      setCookies(reply, clearedCookies());
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/auth/refresh',
    {
      schema: {
        body: OptionalRefreshTokenBodySchema,
        response: { 200: TokenResponseSchema },
      },
    },
    async (request, reply) => {
      const submitted = request.body?.refreshToken;
      const cookie = parseCookies(request.headers.cookie).get(REFRESH_COOKIE);
      const token = submitted ?? cookie;
      const viaCookie = submitted === undefined && cookie !== undefined;

      // Same rule as every other route: a credential the browser attached by
      // itself needs the header only our own page can set.
      if (carriesAuthCookie(request)) {
        assertCsrf(request);
      }

      const rejected = new ApiError('invalid_refresh_token', 401, 'Please sign in again.');
      if (token === undefined) {
        throw rejected;
      }
      const claims = await signer.verifyRefresh(token, now());
      if (claims === null) {
        throw rejected;
      }

      // A reuse detected earlier revoked every token minted from this login,
      // including the ones rotated legitimately before the theft was noticed.
      // That is the point: the thief and the victim are both holding tokens,
      // and there is no way to tell which is which.
      if (await denylist.isDenied(sessionFamilyKey(claims.sessionId))) {
        throw rejected;
      }

      // Rotation as one atomic step: the write *is* the test. Whoever gets
      // `true` spent the token; anyone else — a replay, or the loser of a race
      // between two concurrent presentations — did not, and that is reuse.
      if (!(await denylist.deny(claims.jti, claims.expiresAt))) {
        await denylist.deny(sessionFamilyKey(claims.sessionId), familyExpiry());
        request.log.warn(
          { errorCode: 'refresh_token_reuse' },
          'refresh token replayed — session family revoked',
        );
        throw rejected;
      }

      const tokens = await signer.mintSession({
        userId: claims.userId,
        sessionId: claims.sessionId,
        now: now(),
      });

      noStore(reply);
      if (viaCookie) {
        setCookies(reply, sessionCookies(tokens, randomToken()));
        return { tokenType: 'Bearer', expiresIn: seconds(ACCESS_TOKEN_TTL_MS) } as const;
      }
      return {
        tokenType: 'Bearer',
        expiresIn: seconds(ACCESS_TOKEN_TTL_MS),
        accessToken: tokens.access.token,
        refreshToken: tokens.refresh.token,
      } as const;
    },
  );

  app.get(
    '/v1/auth/device',
    { schema: { response: { 200: DeviceGrantResponseSchema } } },
    async () => {
      const grant = await deviceStore.start();
      return {
        deviceCode: grant.deviceCode,
        userCode: grant.userCode,
        verificationUri,
        verificationUriComplete: `${verificationUri}?userCode=${grant.userCode}`,
        expiresIn: Math.max(1, seconds(grant.expiresAt.getTime() - now().getTime())),
        interval: DEVICE_POLL_INTERVAL_SECONDS,
      };
    },
  );

  /**
   * The consent step. Everything that makes a device grant dangerous is
   * concentrated here: it is authenticated, CSRF-protected, and driven by a
   * code the person has been *shown* — the web app renders "a device is asking
   * for access, code ABCD-EFGH" and this is what its Approve button calls. The
   * session the device receives is the approver's own, which is what stops
   * anyone from being walked into granting somebody else's.
   */
  app.post(
    '/v1/auth/device/approve',
    {
      preHandler: [app.requireSession, app.requireCsrf],
      schema: { body: DeviceDecisionSchema, response: { 204: z.void() } },
    },
    async (request, reply) => {
      const auth = request.auth;
      if (auth === undefined || !(await deviceStore.approve(request.body.userCode, auth.userId))) {
        // Unknown, expired, or already decided — one answer for all three, so
        // this cannot be used to enumerate live codes.
        throw new ApiError('device_request_not_found', 404, 'That sign-in request is not open.');
      }
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/auth/device/deny',
    {
      preHandler: [app.requireSession, app.requireCsrf],
      schema: { body: DeviceDecisionSchema, response: { 204: z.void() } },
    },
    async (request, reply) => {
      if (!(await deviceStore.deny(request.body.userCode))) {
        throw new ApiError('device_request_not_found', 404, 'That sign-in request is not open.');
      }
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/auth/device/token',
    {
      schema: {
        body: z.object({ deviceCode: z.string().min(1).max(128) }),
        response: { 200: TokenResponseSchema },
      },
    },
    async (request, reply) => {
      const claim = await deviceStore.claim(request.body.deviceCode);
      switch (claim.status) {
        case 'pending':
          // RFC 8628's answer: keep polling, nothing is wrong.
          throw new ApiError('authorization_pending', 400, 'Sign-in has not finished yet.');
        case 'denied':
          throw new ApiError('access_denied', 400, 'The sign-in request was declined.');
        case 'expired':
          throw new ApiError('expired_device_code', 400, 'This sign-in request has expired.');
        case 'unknown':
          throw new ApiError('invalid_device_code', 400, 'This sign-in request is not valid.');
        case 'approved': {
          const tokens = await signer.mintSession({ userId: claim.userId, now: now() });
          noStore(reply);
          return {
            tokenType: 'Bearer',
            expiresIn: seconds(ACCESS_TOKEN_TTL_MS),
            accessToken: tokens.access.token,
            refreshToken: tokens.refresh.token,
          } as const;
        }
      }
    },
  );
}
