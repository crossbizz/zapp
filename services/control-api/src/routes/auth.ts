import { timingSafeEqual } from 'node:crypto';

import type { FastifyReply } from 'fastify';
import { z } from 'zod';

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
import type { TokenDenylist } from '../auth/denylist.js';
import { DEVICE_POLL_INTERVAL_SECONDS, type DeviceStore } from '../auth/device.js';
import { AuthPortError, type AuthPort } from '../auth/port.js';
import {
  ACCESS_TOKEN_TTL_MS,
  LOGIN_STATE_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  randomToken,
  type SessionSigner,
  type SessionTokens,
} from '../auth/session.js';
import type { UserStore } from '../auth/users.js';
import { ApiError } from '../errors.js';
import { assertCsrf } from '../plugins/auth.js';

/**
 * PRD §32 `/v1/auth/*` and `/v1/me`.
 *
 * The browser leg (`/login` → provider → `/callback`) ends with three cookies
 * and a redirect; the desktop leg (`/device` → the same browser leg → `/device/token`)
 * ends with a bearer token. Both mint the same session, so everything
 * downstream — `/v1/me` today, every tenant route from CP-4 — has exactly one
 * kind of credential to understand.
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

const MeResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  memberships: z.array(
    z.object({
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

export interface AuthRoutesDeps {
  readonly port: AuthPort;
  readonly users: UserStore;
  readonly config: AuthConfig;
  readonly signer: SessionSigner;
  readonly denylist: TokenDenylist;
  readonly deviceStore: DeviceStore;
  readonly now: () => Date;
}

/** Fastify accumulates repeated `set-cookie` headers into one array. */
function setCookies(reply: FastifyReply, cookies: string[]): void {
  for (const cookie of cookies) {
    reply.header('set-cookie', cookie);
  }
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

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Every way a login handshake can fail says the same thing. */
function invalidState(): ApiError {
  return new ApiError('invalid_state', 400, 'The sign-in request could not be verified.');
}

export function registerAuthRoutes(app: AppInstance, deps: AuthRoutesDeps): void {
  const { port, users, config, signer, denylist, deviceStore, now } = deps;
  const callbackUri = `${config.apiBaseUrl}/v1/auth/callback`;
  const verificationUri = `${config.apiBaseUrl}/v1/auth/login`;

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
          state: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const state = await signer.verifyLoginState(request.query.state, now());
      const nonce = parseCookies(request.headers.cookie).get(OAUTH_STATE_COOKIE) ?? '';
      if (state === null || nonce === '' || !equals(state.nonce, nonce)) {
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

      const user = await users.upsertFromIdentity(identity, now());
      const tokens = await signer.mintSession({ userId: user.id, now: now() });

      // The browser leg doubles as the approval step for a desktop device
      // grant. An unknown or expired code is ignored: this person did log in,
      // and telling a browser which codes exist would be a probing oracle.
      if (state.userCode !== undefined) {
        await deviceStore.approve(state.userCode, user.id);
      }

      setCookies(reply, [
        ...sessionCookies(tokens, randomToken()),
        expireCookie(OAUTH_STATE_COOKIE, { path: AUTH_PATH }),
      ]);
      return reply.redirect(config.appBaseUrl, 302);
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
      return { user: profile.user, memberships: [...profile.memberships] };
    },
  );

  app.post(
    '/v1/auth/logout',
    { preHandler: [app.requireSession, app.requireCsrf] },
    async (request, reply) => {
      const auth = request.auth;
      if (auth !== undefined) {
        await denylist.deny(auth.jti, auth.expiresAt);
        // The refresh token is the one that would let a stolen cookie jar come
        // back tomorrow, so it goes too — when the browser sent one.
        const refresh = parseCookies(request.headers.cookie).get(REFRESH_COOKIE);
        const claims = refresh === undefined ? null : await signer.verifyRefresh(refresh, now());
        if (claims !== null) {
          await denylist.deny(claims.jti, claims.expiresAt);
        }
      }

      setCookies(reply, clearedCookies());
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/auth/refresh',
    {
      schema: {
        body: z.object({ refreshToken: z.string().min(1).optional() }).nullish(),
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
      if (viaCookie) {
        assertCsrf(request);
      }

      const rejected = new ApiError('invalid_refresh_token', 401, 'Please sign in again.');
      if (token === undefined) {
        throw rejected;
      }
      const claims = await signer.verifyRefresh(token, now());
      if (claims === null || (await denylist.isDenied(claims.jti))) {
        throw rejected;
      }

      // Rotation: the token that was just spent is denied for the rest of its
      // life, so replaying a stolen refresh token fails even though it still
      // verifies. The session id survives, which is what ties the chain of
      // tokens to one login.
      await denylist.deny(claims.jti, claims.expiresAt);
      const tokens = await signer.mintSession({
        userId: claims.userId,
        sessionId: claims.sessionId,
        now: now(),
      });

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

  app.post(
    '/v1/auth/device/token',
    {
      schema: {
        body: z.object({ deviceCode: z.string().min(1).max(128) }),
        response: { 200: TokenResponseSchema },
      },
    },
    async (request) => {
      const claim = await deviceStore.claim(request.body.deviceCode);
      switch (claim.status) {
        case 'pending':
          // RFC 8628's answer: keep polling, nothing is wrong.
          throw new ApiError('authorization_pending', 400, 'Sign-in has not finished yet.');
        case 'expired':
          throw new ApiError('expired_device_code', 400, 'This sign-in request has expired.');
        case 'unknown':
          throw new ApiError('invalid_device_code', 400, 'This sign-in request is not valid.');
        case 'approved': {
          const tokens = await signer.mintSession({ userId: claim.userId, now: now() });
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
