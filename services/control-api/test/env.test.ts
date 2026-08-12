import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadAuthEnv } from '../src/auth/config.js';
import {
  loadEnv,
  loadArtifactStorageEnv,
  loadFlexpriceEnv,
  requireFlexpriceForEnvironment,
  loadStripeBillingEnv,
  requireStripeBillingForEnvironment,
  loadGitHubAppEnv,
  loadGitHubWebhookQueueEnv,
  loadMasterKey,
  loadPreviewEnv,
  loadModelGatewayUrl,
  loadNotificationEnv,
  loadPostHogEnv,
  loadRedisUrl,
  loadRunIntentHmacKey,
  loadServiceTokenConfig,
  loadUsageQueueEnv,
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
const PLATFORM_STRIPE_SECRET = ['sk', 'test', 'platformonly'].join('_');
const GENERATED_APP_STRIPE_SECRET = ['rk', 'test', 'generatedapp'].join('_');
const PLATFORM_STRIPE_WEBHOOK_SECRET = ['whsec', 'platformonly'].join('_');

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
  PREVIEW_SHARE_SIGNING_KEY: 'd'.repeat(64),
};

const GITHUB_TEST_ENV = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_SLUG: 'zapp-build-test',
  GITHUB_APP_PRIVATE_KEY: 'test-private-key',
  GITHUB_APP_CLIENT_ID: 'Iv1.test-client',
  GITHUB_APP_CLIENT_SECRET: 'test-client-secret',
  GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
} as const;

describe('the shipped .env.example', () => {
  const template = readTemplate();
  const environment = { ...template, ...GENERATED, ...GITHUB_TEST_ENV };

  it('boots every loader this service calls at startup', () => {
    // `server.ts` calls these six before it listens.
    expect(() => loadEnv(environment)).not.toThrow();
    expect(() => loadAuthEnv(environment)).not.toThrow();
    expect(() => loadRedisUrl(environment)).not.toThrow();
    expect(() => loadMasterKey(environment)).not.toThrow();
    expect(() => loadServiceTokenConfig(environment)).not.toThrow();
    expect(() => loadRunIntentHmacKey(environment)).not.toThrow();
    expect(() => loadPreviewEnv(environment)).not.toThrow();
    expect(() => loadModelGatewayUrl(environment)).not.toThrow();
    expect(() => loadUsageQueueEnv(environment)).not.toThrow();
    expect(() => loadNotificationEnv(environment)).not.toThrow();
    expect(() => loadGitHubAppEnv(environment)).not.toThrow();
    expect(() => loadGitHubWebhookQueueEnv(environment)).not.toThrow();
    expect(() => loadArtifactStorageEnv(environment)).not.toThrow();
    expect(() => loadPostHogEnv(environment)).not.toThrow();
    expect(loadFlexpriceEnv(environment)).toBeUndefined();
    expect(loadStripeBillingEnv(environment)).toBeUndefined();
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
      'PREVIEW_BASE_DOMAIN',
      'PREVIEW_SHARE_SIGNING_KEY',
      'PREVIEW_SHARE_KEY_VERSION',
      'SANDBOX_SERVICE_URL',
      'MODEL_GATEWAY_URL',
      'AWS_REGION',
      'AWS_ENDPOINT_URL',
      'SQS_NOTIFICATION_QUEUE_NAME',
      'SES_NOTIFICATION_SOURCE',
      'SNS_NOTIFICATION_TOPIC_ARN',
      'GITHUB_APP_ID',
      'GITHUB_APP_SLUG',
      'GITHUB_APP_PRIVATE_KEY',
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_APP_CLIENT_SECRET',
      'GITHUB_WEBHOOK_SECRET',
      'GITHUB_API_BASE_URL',
      'ARTIFACT_ENDPOINT',
      'ARTIFACT_REGION',
      'ARTIFACT_BUCKET',
      'ARTIFACT_KEY',
      'ARTIFACT_SECRET',
      'POSTHOG_KEY',
      'POSTHOG_HOST',
    ]) {
      expect(template, name).toHaveProperty(name);
    }
  });

  it('keeps every GitHub App credential entry name-only', () => {
    for (const name of [
      'GITHUB_APP_ID',
      'GITHUB_APP_SLUG',
      'GITHUB_APP_PRIVATE_KEY',
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_APP_CLIENT_SECRET',
      'GITHUB_WEBHOOK_SECRET',
      'GITHUB_API_BASE_URL',
    ]) {
      expect(template, name).toHaveProperty(name, '');
    }
  });
});

describe('PostHog configuration', () => {
  it('loads the server project key and normalizes the host', () => {
    expect(
      loadPostHogEnv({
        POSTHOG_KEY: 'phc_test-project-key',
        POSTHOG_HOST: 'https://us.i.posthog.com/',
      }),
    ).toEqual({ projectKey: 'phc_test-project-key', host: 'https://us.i.posthog.com' });
  });
});

describe('Flexprice production admission', () => {
  it('permits an absent gate only in test or development and refuses production startup', () => {
    expect(() => requireFlexpriceForEnvironment({ NODE_ENV: 'production' }, undefined)).toThrow(
      'FLEXPRICE_API_KEY is required in production',
    );
    expect(requireFlexpriceForEnvironment({ NODE_ENV: 'test' }, undefined)).toBeUndefined();
    expect(requireFlexpriceForEnvironment({ NODE_ENV: 'development' }, undefined)).toBeUndefined();
  });
});

describe('Stripe platform billing configuration', () => {
  it('loads only the platform credential scope and a complete price catalog', () => {
    expect(
      loadStripeBillingEnv({
        PLATFORM_BILLING_STRIPE_SECRET_KEY: PLATFORM_STRIPE_SECRET,
        PLATFORM_BILLING_STRIPE_WEBHOOK_SECRET: PLATFORM_STRIPE_WEBHOOK_SECRET,
        STRIPE_PLAN_PRICE_IDS_JSON: '{"builder":"price_builder123","studio":"price_studio123"}',
        STRIPE_CREDIT_PACK_PRICE_IDS_JSON:
          '{"starter":"price_starter123","scale":"price_scale123"}',
        FLEXPRICE_STRIPE_WEBHOOK_URL:
          'https://api.cloud.flexprice.io/v1/webhooks/stripe/tenant/environment',
      }),
    ).toEqual({
      platformSecretKey: PLATFORM_STRIPE_SECRET,
      webhookSecret: PLATFORM_STRIPE_WEBHOOK_SECRET,
      prices: { builder: 'price_builder123', studio: 'price_studio123' },
      creditPackPrices: { starter: 'price_starter123', scale: 'price_scale123' },
      flexpriceStripeWebhookUrl:
        'https://api.cloud.flexprice.io/v1/webhooks/stripe/tenant/environment',
    });
    expect(() =>
      loadStripeBillingEnv({
        PLATFORM_BILLING_STRIPE_SECRET_KEY: GENERATED_APP_STRIPE_SECRET,
        PLATFORM_BILLING_STRIPE_WEBHOOK_SECRET: PLATFORM_STRIPE_WEBHOOK_SECRET,
        STRIPE_PLAN_PRICE_IDS_JSON: '{"builder":"price_builder123","studio":"price_studio123"}',
        STRIPE_CREDIT_PACK_PRICE_IDS_JSON:
          '{"starter":"price_starter123","scale":"price_scale123"}',
        FLEXPRICE_STRIPE_WEBHOOK_URL:
          'https://api.cloud.flexprice.io/v1/webhooks/stripe/tenant/environment',
      }),
    ).toThrow('PLATFORM_BILLING_STRIPE_SECRET_KEY');
    expect(() =>
      loadStripeBillingEnv({
        PLATFORM_BILLING_STRIPE_SECRET_KEY: PLATFORM_STRIPE_SECRET,
        PLATFORM_BILLING_STRIPE_WEBHOOK_SECRET: PLATFORM_STRIPE_WEBHOOK_SECRET,
        STRIPE_PLAN_PRICE_IDS_JSON: '{"builder":"price_builder123","studio":"price_studio123"}',
        FLEXPRICE_STRIPE_WEBHOOK_URL:
          'https://api.cloud.flexprice.io/v1/webhooks/stripe/tenant/environment',
      }),
    ).toThrow('STRIPE_CREDIT_PACK_PRICE_IDS_JSON');
  });

  it('refuses production without platform billing and permits an absent local provider', () => {
    expect(() => requireStripeBillingForEnvironment({ NODE_ENV: 'production' }, undefined)).toThrow(
      'PLATFORM_BILLING_STRIPE_SECRET_KEY is required in production',
    );
    expect(requireStripeBillingForEnvironment({ NODE_ENV: 'test' }, undefined)).toBeUndefined();
  });
});

describe('Flexprice event ingestion configuration', () => {
  it('enables the production consumer only with a configured API key', () => {
    expect(
      loadFlexpriceEnv({
        FLEXPRICE_API_KEY: 'not-a-real-flexprice-key',
        FLEXPRICE_BASE_URL: 'https://api.cloud.flexprice.io/v1/',
      }),
    ).toEqual({
      apiKey: 'not-a-real-flexprice-key',
      baseUrl: 'https://api.cloud.flexprice.io/v1',
    });
    expect(
      loadFlexpriceEnv({
        FLEXPRICE_API_KEY: 'replace-me',
        FLEXPRICE_BASE_URL: 'https://api.cloud.flexprice.io/v1',
      }),
    ).toBeUndefined();
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
