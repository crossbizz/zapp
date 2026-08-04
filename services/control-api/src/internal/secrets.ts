import type { ServiceAudience, ServiceName } from '@zapp/config';
import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { SecretDecryptionError } from '../secrets/crypto.js';
import type { SecretVault } from '../secrets/vault.js';
import { serviceOf } from './service-auth.js';

/**
 * `POST /internal/secrets/decrypt` — the only way a secret value leaves this
 * service, and the reason PRD §22.2 can say "Read secret values: No through UI"
 * for every role including Owner.
 *
 * Seven properties, and each one is the answer to "how would this become a
 * back door":
 *
 * 1. **Service tokens only.** `requireService` refuses a request carrying any
 *    user credential *before* it looks at anything else, so this route is
 *    unreachable from a browser rather than merely unauthorized there
 *    (`src/internal/service-auth.ts`). A valid session with a valid CSRF header
 *    gets 401, which `test/secrets.test.ts` pins.
 * 2. **An allowlist, not merely authentication.** PRD §18.12 makes plaintext
 *    available "to the sandbox service at injection time"; plan 08's release
 *    service needs the same at deploy time. Those two, by name. Any other
 *    verified service gets 403 — compromising one service's token does not
 *    confer every service's reach.
 *
 *    The 403 is decided from the token alone, before anything reads a row, so
 *    it is the same answer for a secret that exists and one that does not: a
 *    service that may not decrypt cannot use this route as an oracle for which
 *    secrets a tenant holds. `test/service-auth.test.ts` asserts the two
 *    responses are byte-identical.
 * 3. **A reason is required.** Not decoration: the audit row is what an incident
 *    is reconstructed from, and "sandbox-service decrypted DATABASE_URL" answers
 *    a different question than "sandbox-service decrypted DATABASE_URL to start
 *    run run_01…". A field the caller must fill in is the cheapest way to have
 *    that at the time it is cheap to know.
 * 4. **The audit row is written in the transaction that reads the row.** Not
 *    after, not best-effort — see `src/secrets/vault.ts`. A decrypt that
 *    returned a value and left no trail is not a state this service can reach.
 * 5. **The response is never stored or replayed.** The route opts out of the
 *    idempotency plugin: that plugin's whole job is to keep a copy of the
 *    response body in Redis for a minute so a retry can be answered from it, and
 *    the response body here is a plaintext credential. A read has nothing to
 *    make idempotent anyway.
 * 6. **A token spends itself here.** The route is single-use (CP-8): the `jti`
 *    is recorded in the denylist before the handler runs, so a token captured
 *    on its way in is worth at most the one call it was minted for — never a
 *    second copy of the plaintext. Callers mint per call, which is an HMAC and
 *    no network.
 * 7. **The audience is this route.** Only a token minted for
 *    {@link SECRET_DECRYPT_AUDIENCE} is accepted, so a credential intended for
 *    some future internal route is not a credential for the one that hands back
 *    secrets — and vice versa.
 *
 * The response deliberately carries the metadata alongside the value, so the
 * caller does not need a second, unaudited call to learn which environment the
 * value it just received belongs to.
 */

/** Who may ask. PRD §18.12 (sandbox injection) and plan 08 (release-time configuration). */
export const SECRET_DECRYPT_CALLERS: readonly ServiceName[] = ['sandbox-service', 'release-service'];

/**
 * What a token has to have been minted for to be spent here (CP-8).
 *
 * Named after the route rather than after this service, because that is the
 * granularity that buys anything: `control-api` as an audience would make one
 * captured token good for every internal route the control plane ever grows.
 */
export const SECRET_DECRYPT_AUDIENCE: ServiceAudience = 'control-api:secrets.decrypt';

const DecryptBody = z
  .object({
    /**
     * Which tenant's vault. Named rather than derived, because a service call
     * has no session to derive it from — and checked, because it is what scopes
     * the read: a secret that is not this organization's answers 404, the same
     * as one that does not exist.
     */
    organizationId: idSchema('org'),
    secretId: idSchema('sec'),
    /**
     * Why. Long enough to be a sentence rather than a keystroke — a required
     * field that accepts `"x"` is a required field in name only — and bounded,
     * because it is written to a `jsonb` column that is kept for years.
     */
    reason: z.string().trim().min(8).max(500),
  })
  // Strict: a body with an extra field is a caller that believes this route
  // takes a parameter it does not, and silently ignoring it is how "but I sent
  // environmentId" becomes an incident.
  .strict();

const DecryptedSecretSchema = z.object({
  secret: z.object({
    id: z.string(),
    organizationId: z.string(),
    projectId: z.string().nullable(),
    environmentId: z.string().nullable(),
    name: z.string(),
    keyVersion: z.number().int(),
  }),
  /** The plaintext. The one field of the one response in this service that is one. */
  value: z.string(),
});

export interface InternalSecretRoutesDeps {
  readonly vault: SecretVault;
  /** Overridable so a test can prove an unallowlisted caller is refused. */
  readonly callers?: readonly ServiceName[];
}

export function registerInternalSecretRoutes(
  app: AppInstance,
  deps: InternalSecretRoutesDeps,
): void {
  const { vault } = deps;

  app.post(
    '/internal/secrets/decrypt',
    {
      preHandler: [
        app.requireService({
          audience: SECRET_DECRYPT_AUDIENCE,
          callers: deps.callers ?? SECRET_DECRYPT_CALLERS,
          // Property 6: the response is a plaintext credential, so the token
          // that asked for it is spent by asking.
          singleUse: true,
        }),
      ],
      // See property 5 in the file header: the response body is a credential,
      // and the idempotency plugin's job is to keep response bodies.
      config: { idempotency: 'exempt' },
      schema: { body: DecryptBody, response: { 200: DecryptedSecretSchema } },
    },
    async (request) => {
      const caller = serviceOf(request);
      const { organizationId, secretId, reason } = request.body;

      let decrypted;
      try {
        decrypted = await vault.decrypt({
          organizationId,
          secretId,
          // Runs inside the transaction that reads the row (`src/secrets/vault.ts`).
          // The organization comes from the row, not from the body: the two agree
          // by construction, and a trail sourced from the request would record
          // whatever the caller claimed.
          audit: (tx, secret) =>
            request.auditService(tx, {
              organizationId: secret.organizationId,
              action: 'secret.decrypted',
              target: { type: 'secret', id: secret.secretId },
              metadata: {
                secretName: secret.name,
                requestingService: caller.service,
                reason,
              },
            }),
        });
      } catch (error) {
        if (error instanceof SecretDecryptionError) {
          // Our vault could not open our own envelope: a master key that is
          // missing, wrong, or a generation this deployment does not carry.
          // A 500 because it is ours, and the message says nothing about which
          // — `error` is deliberately not attached to the log line either, since
          // its text is about key material.
          request.log.error(
            { secretId, errorCode: 'secret_undecryptable' },
            'secret decrypt failed',
          );
          throw new ApiError('secret_undecryptable', 500, 'That secret could not be decrypted.');
        }
        throw error;
      }

      if (decrypted === undefined) {
        // The same 404 a nonexistent secret gets. An internal caller is trusted
        // to hold a token, not to be told which organizations own which secrets.
        throw new ApiError('secret_not_found', 404, 'That secret does not exist.');
      }

      return {
        secret: {
          id: decrypted.secretId,
          organizationId: decrypted.organizationId,
          projectId: decrypted.projectId,
          environmentId: decrypted.environmentId,
          name: decrypted.name,
          keyVersion: decrypted.keyVersion,
        },
        value: decrypted.value,
      };
    },
  );
}
