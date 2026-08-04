import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for secret values (PRD §18.12, plan 02 CP-7).
 *
 * Every secret gets its own 256-bit data key (a DEK). The value is encrypted
 * under the DEK with AES-256-GCM; the DEK is then encrypted ("wrapped") under a
 * master key that this module never sees. What is stored is the ciphertext, its
 * nonce and tag, the wrapped DEK, and which master key generation wrapped it.
 *
 * Why the envelope rather than encrypting values under the master key directly:
 *
 *   - **Rotating the master key does not re-encrypt the values.** A sweep
 *     unwraps each DEK and re-wraps it — kilobytes of work, not gigabytes — and
 *     the ciphertext column is untouched. That is what makes key rotation an
 *     operation somebody actually performs.
 *   - **The master key never has to leave the KMS.** {@link MasterKeyPort} is
 *     deliberately shaped like AWS KMS' `Encrypt`/`Decrypt`: it wraps and
 *     unwraps a data key and *cannot* hand out the key itself. The environment
 *     implementation below holds bytes in a process; the KMS implementation will
 *     not, and neither this module nor its callers change when it lands.
 *   - **A leaked DEK compromises one secret.** Which is the only blast radius a
 *     compromise has, since no two secrets share one.
 *
 * AES-GCM is authenticated: a modified ciphertext, a swapped nonce, or a
 * wrapped DEK from another secret all fail on `final()` rather than decrypting
 * to something plausible. {@link decryptSecret} lets that failure through as
 * {@link SecretDecryptionError} rather than answering with a guess.
 *
 * **Nothing in this file logs.** Not the plaintext, not a length, not a prefix —
 * a module that is careful about the value it holds and casual about a
 * `log.debug` around it has still written the secret to disk.
 */

/** AES-256: the master key and every DEK are exactly this long. */
export const KEY_BYTES = 32;

/**
 * 96 bits, the size GCM is specified for. A longer nonce is hashed down to this
 * internally and buys nothing; a shorter one narrows the space a repeat has to
 * be avoided in.
 */
const IV_BYTES = 12;

/** GCM's authentication tag, at full length — a truncated tag is a weaker one. */
const TAG_BYTES = 16;

const ALGORITHM = 'aes-256-gcm';

/** Base64 rather than hex: the same bytes in two-thirds of the column width. */
const ENCODING = 'base64';

/**
 * A wrapped data key, and which master key generation wrapped it.
 *
 * The version travels with the wrapped key because unwrapping needs to know
 * which key to ask for, and a vault whose rows do not say cannot be rotated
 * incrementally — only all at once, offline.
 */
export interface WrappedDataKey {
  /** Opaque to everything but the {@link MasterKeyPort} that produced it. */
  readonly wrapped: string;
  readonly keyVersion: number;
}

/**
 * The master key, as a capability rather than as bytes.
 *
 * Implementations wrap and unwrap; none of them exposes the key material, so a
 * caller cannot accidentally acquire it and no future refactor can widen this
 * into "just give me the key". `createEnvMasterKey` is the development and P0
 * implementation; a KMS-backed one satisfies the same three members with a
 * network call, and every caller in this service is already written against it.
 */
export interface MasterKeyPort {
  /** The generation new secrets are wrapped under. Rotation moves this forward. */
  readonly currentVersion: number;
  /** Encrypts a data key under {@link MasterKeyPort.currentVersion}. */
  wrapDataKey(dataKey: Buffer): Promise<WrappedDataKey>;
  /**
   * Decrypts a data key wrapped under `keyVersion`.
   *
   * @throws {SecretDecryptionError} when that generation is not configured, or
   * when the wrapped key does not authenticate under it.
   */
  unwrapDataKey(wrapped: string, keyVersion: number): Promise<Buffer>;
}

/**
 * A value could not be recovered: wrong key, wrong generation, or ciphertext
 * that has been altered.
 *
 * A named class so a caller can answer 500 for "our vault is misconfigured"
 * without pattern-matching on a message — and so nothing is tempted to include
 * the underlying error, which for a GCM failure says nothing useful anyway and
 * for a KMS failure may quote the request.
 */
export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

/** What one encrypted secret consists of. Every field is base64 of raw bytes. */
export interface SecretEnvelope {
  /** The value under AES-256-GCM with the data key. */
  readonly ciphertext: string;
  /** That encryption's 96-bit nonce. */
  readonly iv: string;
  /** That encryption's 128-bit authentication tag. */
  readonly authTag: string;
  /** The data key, encrypted under the master key named by `keyVersion`. */
  readonly wrappedDek: string;
  readonly keyVersion: number;
}

/**
 * `iv || tag || ciphertext`, base64.
 *
 * How the wrapped DEK is framed, and why it is one column rather than three: the
 * only code that reads it is the unwrap on the next line down, so its layout is
 * that function's business. The *value's* nonce and tag are separate columns by
 * contrast, because an operator auditing the vault has a reason to look at them
 * and none to look at this.
 */
function frame(iv: Buffer, authTag: Buffer, ciphertext: Buffer): string {
  return Buffer.concat([iv, authTag, ciphertext]).toString(ENCODING);
}

function unframe(packed: string): { iv: Buffer; authTag: Buffer; ciphertext: Buffer } {
  const raw = Buffer.from(packed, ENCODING);
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new SecretDecryptionError('the wrapped data key is malformed');
  }
  return {
    iv: raw.subarray(0, IV_BYTES),
    authTag: raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    ciphertext: raw.subarray(IV_BYTES + TAG_BYTES),
  };
}

/**
 * A master key held in this process, from `SECRETS_MASTER_KEY` (`src/env.ts`).
 *
 * Correct for development and for P0, and explicitly not the end state: a key in
 * an environment variable is a key in a container's inspect output, in whatever
 * orchestrator holds the secret, and in a core dump. The port above is what lets
 * that be replaced by KMS without a caller changing, and the `keyVersion` on
 * every row is what lets the replacement happen incrementally.
 *
 * `previous` exists so master-key rotation is possible at all: a deployment
 * moves the new key in as current and keeps the old one readable while a sweep
 * re-wraps the DEKs — the same shape as the session signer's `previousSecret`
 * (`src/auth/session.ts`).
 */
export interface EnvMasterKeyConfig {
  /** 32 bytes. Never logged, never returned. */
  readonly key: Buffer;
  readonly version: number;
  /** The generation before `version`, still readable while a re-wrap sweep runs. */
  readonly previous?: { readonly key: Buffer; readonly version: number };
}

export function createEnvMasterKey(config: EnvMasterKeyConfig): MasterKeyPort {
  const keys = new Map<number, Buffer>([[config.version, config.key]]);
  if (config.previous !== undefined) {
    keys.set(config.previous.version, config.previous.key);
  }
  for (const [version, key] of keys) {
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `the master key at version ${String(version)} is not ${String(KEY_BYTES)} bytes`,
      );
    }
  }

  return {
    currentVersion: config.version,

    wrapDataKey(dataKey: Buffer): Promise<WrappedDataKey> {
      const key = keys.get(config.version);
      if (key === undefined) {
        throw new Error('the current master key is not configured');
      }
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      return Promise.resolve({
        wrapped: frame(iv, cipher.getAuthTag(), ciphertext),
        keyVersion: config.version,
      });
    },

    unwrapDataKey(wrapped: string, keyVersion: number): Promise<Buffer> {
      const key = keys.get(keyVersion);
      if (key === undefined) {
        // Named without being quoted at: which generations exist is not
        // something an error message should enumerate.
        throw new SecretDecryptionError(
          `no master key is configured for version ${String(keyVersion)}`,
        );
      }
      const { iv, authTag, ciphertext } = unframe(wrapped);
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
        decipher.setAuthTag(authTag);
        return Promise.resolve(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
      } catch {
        // Deliberately swallowed: a GCM failure carries no information a caller
        // can act on, and re-throwing it would put the cause in a log line
        // beside the id of the secret it belongs to.
        throw new SecretDecryptionError('the wrapped data key did not authenticate');
      }
    },
  };
}

/**
 * Encrypts one secret value. The plaintext is not retained, not returned and
 * not logged; what comes back is what the vault stores.
 */
export async function encryptSecret(
  plaintext: string,
  master: MasterKeyPort,
): Promise<SecretEnvelope> {
  const dataKey = randomBytes(KEY_BYTES);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, dataKey, iv, { authTagLength: TAG_BYTES });
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const { wrapped, keyVersion } = await master.wrapDataKey(dataKey);

    return {
      ciphertext: ciphertext.toString(ENCODING),
      iv: iv.toString(ENCODING),
      authTag: cipher.getAuthTag().toString(ENCODING),
      wrappedDek: wrapped,
      keyVersion,
    };
  } finally {
    // Best effort — V8 may already have copied it — but the buffer this
    // function is certainly holding is not left full of key material for
    // whatever reads the heap next.
    dataKey.fill(0);
  }
}

/**
 * Recovers one secret value.
 *
 * The only function in this service that produces plaintext, and there is
 * exactly one caller: the audited internal decrypt (`src/internal/secrets.ts`).
 * No route reachable by a user session leads here — PRD §22.2 gives every role,
 * Owner included, "Read secret values: No through UI".
 *
 * @throws {SecretDecryptionError}
 */
export async function decryptSecret(
  envelope: SecretEnvelope,
  master: MasterKeyPort,
): Promise<string> {
  const dataKey = await master.unwrapDataKey(envelope.wrappedDek, envelope.keyVersion);
  try {
    const decipher = createDecipheriv(ALGORITHM, dataKey, Buffer.from(envelope.iv, ENCODING), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(Buffer.from(envelope.authTag, ENCODING));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, ENCODING)),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch (error) {
    if (error instanceof SecretDecryptionError) {
      throw error;
    }
    throw new SecretDecryptionError('the secret did not authenticate');
  } finally {
    dataKey.fill(0);
  }
}
