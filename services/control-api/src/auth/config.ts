import { defineEnv } from '@zapp/config';
import { z } from 'zod';

import type { StytchAuthPortConfig } from './stytch.js';

/**
 * Everything the authenticated surface needs, kept out of `src/env.ts` on
 * purpose: that schema exists to let the process boot with an empty environment
 * and carries nothing secret. These have no defaults and never will — a control
 * plane that starts without a session secret is worse than one that refuses to
 * start, and `defineEnv` names the missing variables without printing values.
 */

/**
 * Long enough that HS256 is not the weak link. `.env.example` documents
 * `openssl rand -hex 32`, which is 64 characters; the floor is lower so a
 * base64 or passphrase-derived secret of adequate entropy is not rejected on a
 * technicality, and high enough that the `replace-me` placeholder is.
 */
const MINIMUM_SECRET_LENGTH = 32;

/** Trailing slashes make every URL we build from these ambiguous; drop them once, here. */
const BaseUrl = z
  .string()
  .url()
  .transform((value) => value.replace(/\/+$/, ''));

const AuthEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_JWT_SECRET: z.string().min(MINIMUM_SECRET_LENGTH),
  /**
   * Empty is the steady state — the variable exists in `.env.example` so a
   * rotation is a value change rather than a schema change.
   */
  SESSION_JWT_SECRET_PREVIOUS: z
    .union([z.string().min(MINIMUM_SECRET_LENGTH), z.literal('')])
    .optional(),
  /** Where a browser is sent once it has a session. */
  APP_BASE_URL: BaseUrl,
  /**
   * This service's own public origin. Read from configuration rather than the
   * `Host` header: the callback URI and the device verification URI are both
   * built from it, and a header is something a caller controls.
   */
  API_BASE_URL: BaseUrl,
  STYTCH_PROJECT_ID: z.string().min(1),
  STYTCH_SECRET: z.string().min(1),
  STYTCH_PUBLIC_TOKEN: z.string().min(1),
  /**
   * Which Stytch discovery provider `/v1/auth/login` starts. One per
   * deployment for now: `AuthPort.getAuthorizationUrl` takes no provider (the
   * interface is fixed by plan 02 CP-2), so offering the full set is a CP-3
   * change to that signature rather than a configuration trick here.
   */
  STYTCH_OAUTH_PROVIDER: z
    .string()
    .regex(/^[a-z][a-z0-9_-]*$/)
    .default('google'),
});

/** What the session layer needs: the keys it signs with and the origins it redirects to. */
export interface AuthConfig {
  readonly sessionSecret: string;
  /** Accepted for verification only, while a rotation is in flight. */
  readonly previousSecret?: string;
  readonly appBaseUrl: string;
  readonly apiBaseUrl: string;
}

export interface AuthEnv {
  readonly config: AuthConfig;
  readonly stytch: StytchAuthPortConfig;
  readonly databaseUrl: string;
}

/** @throws Error naming the offending variables — never their values. */
export function loadAuthEnv(source: unknown = process.env): AuthEnv {
  const env = defineEnv(AuthEnvSchema, source);
  const previous = env.SESSION_JWT_SECRET_PREVIOUS;

  return {
    databaseUrl: env.DATABASE_URL,
    config: {
      sessionSecret: env.SESSION_JWT_SECRET,
      ...(previous === undefined || previous === '' ? {} : { previousSecret: previous }),
      appBaseUrl: env.APP_BASE_URL,
      apiBaseUrl: env.API_BASE_URL,
    },
    stytch: {
      projectId: env.STYTCH_PROJECT_ID,
      secret: env.STYTCH_SECRET,
      publicToken: env.STYTCH_PUBLIC_TOKEN,
      oauthProvider: env.STYTCH_OAUTH_PROVIDER,
    },
  };
}
