import type { AuditHook } from '../plugins/audit.js';
import type { TenantDbFactory } from '../tenant/db.js';
import { decryptSecret, encryptSecret, type MasterKeyPort, type SecretEnvelope } from './crypto.js';

/**
 * The vault as the rest of the service uses it: encrypt on the way in, and one
 * audited read on the way out.
 *
 * Two jobs, and the second is the reason this module exists rather than the
 * route calling `crypto.ts` and `tenant/db.ts` itself:
 *
 *   - **`src/internal/` may not reach a database handle.** The convention that
 *     makes tenant isolation structural (`test/route-isolation.test.ts`, and the
 *     ESLint rule beside it) bans `@zapp/db`, Drizzle and the tenant factory
 *     from every module that answers a request. The internal decrypt route has
 *     no session, so it cannot receive `ctx.db` from the tenant plugin the way a
 *     user-facing route does — it names an organization in its body instead, and
 *     *this* is where that name is turned into a scoped handle. One place, one
 *     line, reviewable.
 *   - **The audit row is not the route's to forget.** {@link SecretVault.decrypt}
 *     takes the hook as an argument and passes it to the read, which runs it
 *     inside the reading transaction. There is no code path through this
 *     interface that returns a plaintext without having written a row.
 */

/** What the audit hook is told: metadata, never the value it is about to release. */
export interface SecretRead {
  readonly secretId: string;
  readonly organizationId: string;
  readonly name: string;
}

/** One decrypted secret. The only shape in this service that carries a plaintext. */
export interface DecryptedSecret {
  readonly secretId: string;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly environmentId: string | null;
  readonly name: string;
  readonly keyVersion: number;
  /** The plaintext. Returned to one caller, on one route, and never logged. */
  readonly value: string;
}

export interface DecryptRequest {
  /** Which tenant's vault to look in. Scoping, not a filter — see the module comment. */
  readonly organizationId: string;
  readonly secretId: string;
  readonly audit: AuditHook<SecretRead>;
}

export interface SecretVault {
  /** Encrypts a value for storage. The plaintext is not retained anywhere. */
  encrypt(plaintext: string): Promise<SecretEnvelope>;
  /**
   * Reads one secret, records the read, and returns the plaintext.
   *
   * `undefined` when the secret is not that organization's, or does not exist —
   * the same answer for both, since the handle cannot tell them apart either.
   *
   * @throws {import('./crypto.js').SecretDecryptionError} when the stored
   * envelope does not authenticate under the configured master keys.
   */
  decrypt(request: DecryptRequest): Promise<DecryptedSecret | undefined>;
}

export interface SecretVaultDeps {
  readonly tenantDb: TenantDbFactory;
  readonly masterKey: MasterKeyPort;
}

export function createSecretVault(deps: SecretVaultDeps): SecretVault {
  const { tenantDb, masterKey } = deps;

  return {
    encrypt(plaintext: string): Promise<SecretEnvelope> {
      return encryptSecret(plaintext, masterKey);
    },

    async decrypt(request: DecryptRequest): Promise<DecryptedSecret | undefined> {
      const stored = await tenantDb(request.organizationId).secrets.readEnvelope({
        secretId: request.secretId,
        audit: (tx, secret) =>
          request.audit(tx, {
            secretId: secret.id,
            organizationId: secret.organizationId,
            name: secret.name,
          }),
      });
      if (stored === undefined) {
        return undefined;
      }

      /**
       * Unwrapping happens *after* that transaction has committed, deliberately.
       *
       * The environment-backed master key makes this a microsecond of CPU, but
       * the KMS-backed one makes it a network round trip — and holding a
       * transaction (and the pool connection under it) open across a call to
       * somebody else's service is the connection-pool hazard the CP-6 review
       * raised about the git port. The audit row is therefore atomic with the
       * *release of the key material*, which is the auditable event: a decrypt
       * that succeeded is always recorded, and the only imprecision runs the
       * safe way — a row for a release whose unwrap then failed, which means the
       * vault is misconfigured and somebody should be looking anyway.
       */
      return {
        secretId: stored.secret.id,
        organizationId: stored.secret.organizationId,
        projectId: stored.secret.projectId,
        environmentId: stored.secret.environmentId,
        name: stored.secret.name,
        keyVersion: stored.secret.keyVersion,
        value: await decryptSecret(stored.envelope, masterKey),
      };
    },
  };
}
