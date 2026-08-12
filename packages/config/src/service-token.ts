import { randomUUID } from 'node:crypto';

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

/**
 * The credential one zapp service presents to another (plan 02 CP-8).
 *
 * It lives here, in the package every service already depends on for its
 * environment, because signing and verification have to agree exactly and the
 * cheapest way to guarantee that is for there to be one implementation. A
 * service that minted its own tokens would be one refactor away from a claim
 * set the verifier does not check.
 *
 * The shape is an HS256 JWT over `SERVICE_TOKEN_SECRET`, and every part of it
 * is load-bearing:
 *
 *   - **`iss`** is `zapp-control-plane`, **`aud`** is what the token may be
 *     presented to, and both are checked. Together they are what stops a
 *     credential minted for one purpose being spent on another: a token the
 *     sandbox service holds for `control-api:secrets.decrypt` is not a token for
 *     anything else, and a user session — a different secret, a different
 *     issuer, a different audience — is not a service token at all.
 *   - **`sub`** is the calling service, checked against {@link SERVICE_NAMES}.
 *     A signature proves the token came from something holding the secret; the
 *     name is what a route's allowlist decides on, so it has to be a closed set
 *     rather than whatever string the minter chose.
 *   - **`jti`** is unique per token, which is what makes a token *spendable*:
 *     the control plane records it and refuses the second presentation
 *     (`services/control-api/src/internal/service-auth.ts`).
 *   - **`exp` and `iat`** bound the window a captured token is worth anything
 *     in. Minutes, not hours — see {@link MAX_SERVICE_TOKEN_TTL_SECONDS}.
 *
 * HS256 rather than a keypair, for the reason `createSessionSigner` gives: the
 * signers and the verifier are all zapp's own processes inside one deployment,
 * so an asymmetric key would buy nothing and cost a distribution problem. The
 * corollary is that *any* holder of the secret can mint *any* service's token —
 * which is why the secret is a deployment secret and never reaches a sandbox, an
 * agent, or a generated app.
 */

/**
 * Every service that may hold a token, by name (plan 02 CP-8).
 *
 * Closed on purpose. A route's allowlist is a subset of this list, so a name
 * that is not here cannot be granted anything — which makes adding a caller a
 * reviewed edit in two places rather than a string a deployment invented.
 */
export const SERVICE_NAMES = [
  'orchestrator-worker',
  'sandbox-service',
  'verification-service',
  'release-service',
  'git-service',
  'model-gateway',
  /**
   * The control plane, added by plan 06 GIT-2 — and it is the *seventh* entry
   * for a reason worth writing down, because CP-8 defined this list as six and
   * `control-api` as explicitly not one of them.
   *
   * That was right while the control plane only ever *verified* tokens: a
   * verifier that also appeared in the list of things it verifies is a name
   * nobody could distinguish from a caller. It stopped being right when the
   * control plane acquired something to call. Creating a project provisions a
   * repository through the git service, inside the transaction that writes the
   * project row (`services/control-api/src/git/client.ts`), so the control plane
   * now holds a credential like any other caller and must be nameable as `sub`.
   *
   * Nothing is weakened by the addition. `SERVICE_TOKEN_AUDIENCES` gains
   * `control-api` as an audience, which only matters for a route that verifies
   * it — there is none — and every internal route still names its own allowlist,
   * so being in this list confers reach nowhere.
   */
  'control-api',
] as const;

export type ServiceName = (typeof SERVICE_NAMES)[number];

/** Whether `value` names a service. The verifier's `sub` check, and reusable by a caller. */
export function isServiceName(value: unknown): value is ServiceName {
  return typeof value === 'string' && (SERVICE_NAMES as readonly string[]).includes(value);
}

/** Who mints. One control plane, so one issuer, and it is checked on every token. */
export const SERVICE_TOKEN_ISSUER = 'zapp-control-plane';

/**
 * What a token may be presented to.
 *
 * Two kinds of entry, and the distinction is the point. A **route audience**
 * (`control-api:…`) narrows a token to one endpoint of the control plane, so a
 * credential captured on its way to the decrypt route cannot be spent on some
 * future internal route that is merely less careful. A **service name** is the
 * audience for a call *to* that service, which is what plans 03–08 will use
 * when they start calling each other.
 *
 * Closed, like {@link SERVICE_NAMES}: an audience nobody verifies is a token
 * nobody can spend, and finding that out at compile time beats finding it out
 * from a 401 in staging.
 */
export const SERVICE_TOKEN_AUDIENCES = [
  /** `POST /internal/secrets/decrypt` — the one internal route today (plan 02 CP-7). */
  'control-api:secrets.decrypt',
  /** `POST /internal/runs/:runId/events` — the sequenced orchestration event writer (plan 02 CP-13). */
  'control-api:events.ingest',
  /** ADR-0025 model completion claim/commit/get boundary. */
  'control-api:model-completions',
  /** ADR-0025 approval-backed run ceiling increase boundary. */
  'control-api:credit-ceilings',
  /** OPS-1B append-only non-model usage writer. */
  'control-api:usage.ingest',
  /** OPS-11 release-service synthetic failure ingestion boundary. */
  'control-api:incidents.ingest',
  ...SERVICE_NAMES,
] as const;

export type ServiceAudience = (typeof SERVICE_TOKEN_AUDIENCES)[number];

/**
 * The only algorithm, pinned at both ends.
 *
 * Passed to `jwtVerify` as the *sole* permitted algorithm rather than left to be
 * inferred from the header, because "trust the header's `alg`" is the classic
 * JWT vulnerability: `alg: none` asks the verifier to skip the check, and
 * `alg: RS256` against an HMAC verifier asks it to treat the public key as the
 * shared secret. Both are refused here before a signature is even considered.
 */
const ALGORITHM = 'HS256';

/**
 * How long a token lives when the caller does not say. Five minutes: long
 * enough to cover a retry and a slow hop, short enough that a token captured
 * from a log or a crash dump is worthless by the time anyone reads it.
 */
export const DEFAULT_SERVICE_TOKEN_TTL_SECONDS = 300;

/**
 * The ceiling, enforced when signing and **twice** when verifying.
 *
 * Signing, so a caller cannot mint itself a long-lived credential; verifying,
 * because every service shares one secret and therefore a patched or
 * compromised minter could otherwise issue a token good for a month — and it is
 * that caller, not the honest one, the verify-side checks exist for.
 *
 * Twice, because the obvious check is only half of it. `exp - iat` bounds the
 * *width* of the validity window and nothing bounds where the window sits: jose
 * reads `iat` only when `maxTokenAge` is set, so a minter that dates both claims
 * a year forward produces a ten-minute token that verifies for a year (CP-8
 * review). So `exp` is bounded against *now* as well, which is what makes the
 * ceiling a property of the system rather than of the signer's honesty — and
 * what keeps the denylist entry a spent token writes measured in minutes.
 */
export const MAX_SERVICE_TOKEN_TTL_SECONDS = 600;

export interface SignServiceTokenInput {
  /** Who is calling. Becomes `sub`, and is what a route's allowlist matches. */
  readonly service: ServiceName;
  /** What the token may be presented to. Becomes `aud`. */
  readonly aud: ServiceAudience;
  /** Defaults to {@link DEFAULT_SERVICE_TOKEN_TTL_SECONDS}; never more than the ceiling. */
  readonly ttlSec?: number;
  /** Injected by tests so expiry is asserted rather than waited for. */
  readonly now?: Date;
}

export interface IssuedServiceToken {
  readonly token: string;
  /** The `jti`. What a single-use route records to refuse the second presentation. */
  readonly jti: string;
  readonly expiresAt: Date;
}

/** A token that verified. Every field comes from the signature, never from a request. */
export interface ServiceTokenClaims {
  readonly service: ServiceName;
  readonly audience: ServiceAudience;
  readonly jti: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/**
 * Why a token was refused — for the log, never for the caller.
 *
 * The service that presented a bad token learns only that it was bad
 * (`services/control-api/src/internal/service-auth.ts` answers one code for all
 * of these). An operator reading the log learns which, because the difference
 * between `expired` and `signature` is the difference between a clock to fix
 * and an attack to investigate, and `algorithm` is only ever the latter.
 */
export type ServiceTokenRejection =
  /** Not a JWS at all, or one whose header or payload will not parse. */
  | 'malformed'
  /** The header asked for something other than HS256 — `none`, `RS256`, anything. */
  | 'algorithm'
  /** No configured key produced this signature. A forgery, or a secret rotated away. */
  | 'signature'
  /** A required claim (`exp`, `iat`, `jti`, `sub`) is missing. */
  | 'incomplete'
  | 'expired'
  /** `nbf` puts the token's validity in the future. Nothing here mints one. */
  | 'not_yet_valid'
  /** Minted for something else, or for several things at once — see the `aud` check. */
  | 'audience'
  | 'issuer'
  /** `sub` is not one of {@link SERVICE_NAMES}. */
  | 'service'
  /** `exp - iat` exceeds {@link MAX_SERVICE_TOKEN_TTL_SECONDS}. */
  | 'lifetime';

export type ServiceTokenVerdict =
  | { readonly ok: true; readonly claims: ServiceTokenClaims }
  | { readonly ok: false; readonly reason: ServiceTokenRejection };

export interface ServiceTokenConfig {
  readonly secret: string;
  /**
   * Verified against, never signed with — the same rotation shape as
   * `SESSION_JWT_SECRET_PREVIOUS`. Set only while a rotation is in flight, which
   * is what lets the secret change without every in-flight token becoming a 401.
   */
  readonly previousSecret?: string;
}

export interface ServiceTokenSigner {
  /** @throws Error for an unknown service, an unknown audience, or a TTL over the ceiling. */
  signServiceToken(input: SignServiceTokenInput): Promise<IssuedServiceToken>;
  /**
   * Checks the signature, the algorithm, the issuer, the audience, the expiry,
   * the lifetime and the subject. Never throws for a bad token: an invalid
   * credential is an answer, not an exception.
   *
   * Replay is deliberately *not* checked here — it needs shared state, and this
   * module has no dependencies beyond a secret. The control plane spends the
   * `jti` (`services/control-api/src/internal/service-auth.ts`).
   */
  verifyServiceToken(
    token: string,
    expectedAud: ServiceAudience,
    now?: Date,
  ): Promise<ServiceTokenVerdict>;
}

/** Maps a jose failure onto the reason an operator needs, without a stack trace. */
function classify(error: unknown): ServiceTokenRejection {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'signature';
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return 'algorithm';
    case 'ERR_JWT_EXPIRED':
      return 'expired';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
      switch ((error as { claim?: unknown }).claim) {
        case 'aud':
          return 'audience';
        case 'iss':
          return 'issuer';
        case 'nbf':
          // Not a missing claim: a token dated to start working later. Nothing
          // here mints one, so seeing it in the log means a minter that is not
          // this module — which is worth being able to read as its own word.
          return 'not_yet_valid';
        default:
          return 'incomplete';
      }
    }
    default:
      // ERR_JWS_INVALID, ERR_JWT_INVALID, a JSON payload that is not an object,
      // and anything jose grows later. All of them mean "this is not one of
      // ours", and none of them is worth its own branch.
      return 'malformed';
  }
}

const rejected = (reason: ServiceTokenRejection): ServiceTokenVerdict => ({ ok: false, reason });

export function createServiceTokenSigner(config: ServiceTokenConfig): ServiceTokenSigner {
  const encoder = new TextEncoder();
  const signingKey = encoder.encode(config.secret);
  // Current key first, so a rotation costs one failed verification only for the
  // tokens minted before it — and, since a service token lives minutes, only
  // for minutes.
  const verificationKeys = [signingKey];
  if (config.previousSecret !== undefined && config.previousSecret !== '') {
    verificationKeys.push(encoder.encode(config.previousSecret));
  }

  return {
    async signServiceToken({ service, aud, ttlSec = DEFAULT_SERVICE_TOKEN_TTL_SECONDS, now }) {
      // Checked at runtime as well as in the types: the enums are the whole
      // authorization vocabulary, and a JavaScript caller (or a value that
      // arrived as `string`) must not be able to widen them.
      if (!isServiceName(service)) {
        throw new Error(`signServiceToken: ${String(service)} is not a known service`);
      }
      if (!(SERVICE_TOKEN_AUDIENCES as readonly string[]).includes(aud)) {
        throw new Error(`signServiceToken: ${aud} is not a known audience`);
      }
      if (!Number.isInteger(ttlSec) || ttlSec <= 0 || ttlSec > MAX_SERVICE_TOKEN_TTL_SECONDS) {
        // Refused at minting time, so a caller that wants a long-lived
        // credential fails at its own boot rather than at somebody else's 401.
        throw new Error(
          `signServiceToken: ttlSec must be a whole number of seconds in 1…${String(
            MAX_SERVICE_TOKEN_TTL_SECONDS,
          )}`,
        );
      }

      const issuedAt = now ?? new Date();
      // Whole seconds, because `exp` and `iat` are whole seconds: computing the
      // expiry from an unrounded `iat` is how `exp - iat` ends up one second
      // over a ceiling that was met exactly.
      const issuedAtSeconds = Math.floor(issuedAt.getTime() / 1000);
      const expiresAtSeconds = issuedAtSeconds + ttlSec;
      const jti = randomUUID();

      const token = await new SignJWT({})
        .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
        .setIssuer(SERVICE_TOKEN_ISSUER)
        .setAudience(aud)
        .setSubject(service)
        .setJti(jti)
        .setIssuedAt(issuedAtSeconds)
        .setExpirationTime(expiresAtSeconds)
        .sign(signingKey);

      return { token, jti, expiresAt: new Date(expiresAtSeconds * 1000) };
    },

    async verifyServiceToken(token, expectedAud, now) {
      // Resolved once: `jwtVerify` and the ceiling below must judge the token
      // against the same instant, or a token can be unexpired for one and
      // over-long for the other on either side of a second boundary.
      const currentDate = now ?? new Date();

      for (const key of verificationKeys) {
        let payload: JWTPayload;
        try {
          payload = (
            await jwtVerify(token, key, {
              // Pinned, not inferred. See {@link ALGORITHM}.
              algorithms: [ALGORITHM],
              issuer: SERVICE_TOKEN_ISSUER,
              audience: expectedAud,
              requiredClaims: ['exp', 'iat', 'jti', 'sub'],
              currentDate,
              // Zero: every one of these tokens is minted inside the cluster
              // that verifies it, so hosts that disagree about the time is a
              // fault to fix rather than a tolerance to widen. A window here
              // would widen the replay window by exactly as much.
              clockTolerance: 0,
            })
          ).payload;
        } catch (error) {
          const reason = classify(error);
          if (reason !== 'signature') {
            // jose checks the signature before the claims, so anything but a
            // signature failure means *this* key was the right one and the
            // token is wrong. Trying the previous key could only produce the
            // same answer.
            return rejected(reason);
          }
          continue;
        }

        const { sub, jti, iat, exp } = payload;
        if (typeof jti !== 'string' || typeof iat !== 'number' || typeof exp !== 'number') {
          // `requiredClaims` proves they are present; this proves they are the
          // types the rest of this function reads them as.
          return rejected('incomplete');
        }
        if (payload.aud !== expectedAud) {
          // jose is satisfied by an `aud` *array* that contains the expected
          // value. Only a minter that has been changed can produce one, which
          // is exactly the caller this check exists for: a token addressed to
          // four audiences at once is not a token addressed to this route.
          return rejected('audience');
        }
        if (!isServiceName(sub)) {
          return rejected('service');
        }
        if (exp - iat > MAX_SERVICE_TOKEN_TTL_SECONDS) {
          // The window the token claims for itself is wider than the ceiling.
          // Catches a back-dated `iat` — a lie about the token's age, which is
          // a claim the returned `issuedAt` carries into whatever records it.
          return rejected('lifetime');
        }
        if (exp * 1000 - currentDate.getTime() > MAX_SERVICE_TOKEN_TTL_SECONDS * 1000) {
          // …and the same ceiling measured from *now*, which is the half that
          // actually bounds anything. `exp - iat` bounds the width of the
          // window; nothing bounds where the window sits, because jose reads
          // `iat` only when `maxTokenAge` is set. A minter that dates both
          // claims a year forward therefore produces a ten-minute token that is
          // valid for a year — and, spent on a single-use route, a denylist
          // entry with a year-long TTL (`internal/service-auth.ts`). Two
          // comparisons, and the bound stops being a bound on the signer's
          // honesty.
          //
          // No new dependence on the clock: `exp` is already compared against
          // it by `jwtVerify` above.
          return rejected('lifetime');
        }

        return {
          ok: true,
          claims: {
            service: sub,
            audience: expectedAud,
            jti,
            issuedAt: new Date(iat * 1000),
            expiresAt: new Date(exp * 1000),
          },
        };
      }

      return rejected('signature');
    },
  };
}
