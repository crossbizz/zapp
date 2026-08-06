import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadAuthEnv } from '../src/auth/config.js';
import {
  loadEnv,
  loadMasterKey,
  loadRedisUrl,
  loadRunIntentHmacKey,
  loadServiceTokenConfig,
} from '../src/env.js';

/**
 * Whether the environment this repository *ships* actually boots this service.
 *
 * Not a hand-written fixture: `.env.example` is what `scripts/dev-up.sh` copies
 * to `.env`, so a schema that disagrees with it is a clean checkout that cannot
 * run `pnpm dev` — which is exactly what happened. `SECRETS_PREVIOUS_MASTER_KEY`
 * was `z.string().min(1).optional()`, the template ships it empty because empty
 * is the steady state for a rotation variable, and the two together threw
 * `Invalid environment: SECRETS_PREVIOUS_MASTER_KEY` at boot (plan 02 CP-7
 * review). A fixture written next to the schema would have agreed with the
 * schema and proved nothing.
 *
 * So this file parses the template itself. The only substitutions are the
 * secrets the template tells the reader to generate — and even those are
 * checked: a new `replace-me` variable that one of these loaders reads will
 * fail here rather than in somebody's terminal.
 */

const TEMPLATE_PATH = fileURLToPath(new URL('../../../.env.example', import.meta.url));

/** `KEY=value` lines, comments and blanks dropped. Values are taken verbatim. */
function readTemplate(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of readFileSync(TEMPLATE_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator > 0) {
      entries[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
    }
  }
  return entries;
}

/**
 * What `openssl` would produce, standing in for the four placeholders the
 * template documents as "generate this". Everything else in the file is used
 * exactly as shipped.
 */
const GENERATED: Record<string, string> = {
  SESSION_JWT_SECRET: 'a'.repeat(64),
  SERVICE_TOKEN_SECRET: 'b'.repeat(64),
  RUN_INTENT_HMAC_SECRET: 'c'.repeat(64),
  SECRETS_MASTER_KEY: Buffer.alloc(32, 0x2a).toString('base64'),
};

describe('the shipped .env.example', () => {
  const template = readTemplate();
  const environment = { ...template, ...GENERATED };

  it('boots every loader this service calls at startup', () => {
    // `server.ts` calls these six before it listens.
    expect(() => loadEnv(environment)).not.toThrow();
    expect(() => loadAuthEnv(environment)).not.toThrow();
    expect(() => loadRedisUrl(environment)).not.toThrow();
    expect(() => loadMasterKey(environment)).not.toThrow();
    expect(() => loadServiceTokenConfig(environment)).not.toThrow();
    expect(() => loadRunIntentHmacKey(environment)).not.toThrow();
  });

  it('leaves every rotation variable empty, and empty is accepted', () => {
    // Empty is the steady state for all three: a rotation is then a value
    // change rather than a schema change, and a fresh checkout is not a
    // rotation. This is the pairing that broke — the template says empty, so
    // the schema has to mean it.
    for (const name of [
      'SESSION_JWT_SECRET_PREVIOUS',
      'SERVICE_TOKEN_SECRET_PREVIOUS',
      'SECRETS_PREVIOUS_MASTER_KEY',
    ]) {
      expect(template, name).toHaveProperty(name, '');
    }
    // …and none of them was read as a *configured* previous key: the vault
    // comes up at generation one (a present previous key there is refused —
    // see below), and the signer comes up with no verification-only secret.
    expect(loadMasterKey(environment).currentVersion).toBe(1);
    expect(loadServiceTokenConfig(environment)).toEqual({ secret: GENERATED.SERVICE_TOKEN_SECRET });
  });

  it('substitutes only the placeholders it documents as generated', () => {
    // A guard on the guard: if a later plan adds a `replace-me` variable that
    // one of the loaders above reads, this test must be updated rather than
    // quietly passing because the schema accepted the literal string.
    const placeholders = Object.entries(template)
      .filter(([, value]) => value.includes('replace-me'))
      .map(([name]) => name);

    for (const name of Object.keys(GENERATED)) {
      expect(placeholders, name).toContain(name);
    }
    // The rest are third-party credentials no loader in this service validates
    // beyond "not empty" — Stytch's, Modal's, the model providers', Stripe's.
    expect(placeholders.filter((name) => !(name in GENERATED)).length).toBeGreaterThan(0);
  });

  it('names every variable the control plane requires', () => {
    // The mirror of the test above: a loader gaining a required variable that
    // nobody added to the template is the same failure in the other direction.
    for (const name of [
      'DATABASE_URL',
      'REDIS_URL',
      'APP_BASE_URL',
      'API_BASE_URL',
      'SESSION_JWT_SECRET',
      'SERVICE_TOKEN_SECRET',
      'RUN_INTENT_HMAC_SECRET',
      'SECRETS_MASTER_KEY',
      'STYTCH_PROJECT_ID',
      'STYTCH_SECRET',
      'STYTCH_PUBLIC_TOKEN',
    ]) {
      expect(template, name).toHaveProperty(name);
    }
  });
});

describe('the rotation variables', () => {
  const base = { ...readTemplate(), ...GENERATED };

  it('treats an empty previous master key as no rotation, at any version', () => {
    // Version 1 has nothing before it, so a *present* previous key is refused
    // there — but an empty one is not a present one.
    expect(() => loadMasterKey({ ...base, SECRETS_MASTER_KEY_VERSION: '1' })).not.toThrow();
    expect(() =>
      loadMasterKey({
        ...base,
        SECRETS_MASTER_KEY_VERSION: '1',
        SECRETS_PREVIOUS_MASTER_KEY: Buffer.alloc(32, 0x2b).toString('base64'),
      }),
    ).toThrow(/SECRETS_MASTER_KEY_VERSION/);
  });

  it('accepts a real previous secret for verification, and refuses a short one', () => {
    expect(
      loadServiceTokenConfig({ ...base, SERVICE_TOKEN_SECRET_PREVIOUS: 'c'.repeat(64) }),
    ).toEqual({ secret: GENERATED.SERVICE_TOKEN_SECRET, previousSecret: 'c'.repeat(64) });
    // Not "anything non-empty": a short previous secret is a typo, and a typo
    // that verifies tokens is worse than one that refuses to boot.
    expect(() =>
      loadServiceTokenConfig({ ...base, SERVICE_TOKEN_SECRET_PREVIOUS: 'short' }),
    ).toThrow(/SERVICE_TOKEN_SECRET_PREVIOUS/);
  });

  it('refuses to start without a service-token secret, naming it and not its value', () => {
    const without = { ...base };
    delete without['SERVICE_TOKEN_SECRET'];
    expect(() => loadServiceTokenConfig(without)).toThrow(
      new Error('Invalid environment: SERVICE_TOKEN_SECRET'),
    );
    expect(() => loadServiceTokenConfig({ ...base, SERVICE_TOKEN_SECRET: 'replace-me' })).toThrow(
      new Error('Invalid environment: SERVICE_TOKEN_SECRET'),
    );
  });
});

describe('the durable run-intent fingerprint key', () => {
  const base = { ...readTemplate(), ...GENERATED };

  it('decodes exactly 64 hexadecimal characters into 32 key bytes', () => {
    expect(loadRunIntentHmacKey(base)).toEqual(Buffer.alloc(32, 0xcc));

    for (const value of ['c'.repeat(63), 'c'.repeat(65), 'g'.repeat(64), 'replace-me']) {
      expect(() => loadRunIntentHmacKey({ ...base, RUN_INTENT_HMAC_SECRET: value })).toThrow(
        new Error('Invalid environment: RUN_INTENT_HMAC_SECRET'),
      );
    }
  });

  it('has no production default and names only the missing variable', () => {
    const without = { ...base };
    delete without['RUN_INTENT_HMAC_SECRET'];

    expect(() => loadRunIntentHmacKey(without)).toThrow(
      new Error('Invalid environment: RUN_INTENT_HMAC_SECRET'),
    );
  });
});
