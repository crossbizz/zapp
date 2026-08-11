import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { credentialGate, isPlaceholder } from './support/credentials.js';

/**
 * The gate that decides whether a credential-gated suite runs, tested against
 * the file that broke it.
 *
 * The Stytch integration suite used to be gated on `STYTCH_SECRET !== ''`.
 * `.env.example` ships `STYTCH_SECRET=replace-me`, `scripts/dev-up.sh` copies
 * that file to `.env`, and the suite therefore ran — and passed — against a
 * project that does not exist. So the last test here does not assert against a
 * fixture: it parses the shipped template and requires that what it ships is
 * still recognised as absent.
 */

const TEMPLATE_PATH = fileURLToPath(new URL('../../../.env.example', import.meta.url));

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

describe('isPlaceholder', () => {
  it('recognises the shapes a template ships so a variable merely exists', () => {
    for (const value of [
      'replace-me',
      'REPLACE-ME',
      'replace_me',
      'public-token-test-replace-me',
      'sk_test_replace-me',
      'project-test-replace-me',
      'changeme',
      'project-test-00000000-0000-0000-0000-000000000000',
      'TODO',
      'xxxx',
    ]) {
      expect(isPlaceholder(value), value).toBe(true);
    }
  });

  it('leaves working local credentials alone', () => {
    // These look like throwaways and are throwaways — and they are also what the
    // dev stack actually authenticates with. A gate that refused them would turn
    // every local integration suite into a permanent skip, which is the same
    // failure in the other direction.
    for (const value of [
      'postgres://zapp:zapp@localhost:5432/zapp',
      'redis://localhost:6379',
      'minioadmin',
      'http://localhost:3300',
      'secret-test-9f0b2c1d4e5a',
      'project-test-11111111-2222-3333-4444-555555555555',
    ]) {
      expect(isPlaceholder(value), value).toBe(false);
    }
  });
});

describe('credentialGate', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('is closed when a variable is unset, and says which', () => {
    delete process.env['ZAPP_GATE_TEST_A'];
    const gate = credentialGate(['ZAPP_GATE_TEST_A']);
    expect(gate.present).toBe(false);
    expect(gate.reason).toBe('ZAPP_GATE_TEST_A is unset');
  });

  it('is closed for a placeholder, and says so differently from unset', () => {
    // The distinction is the whole point of the message: "unset" is a machine
    // that was never configured, "still a placeholder" is one that someone
    // believes they configured.
    process.env['ZAPP_GATE_TEST_A'] = 'replace-me';
    const gate = credentialGate(['ZAPP_GATE_TEST_A']);
    expect(gate.present).toBe(false);
    expect(gate.reason).toBe('ZAPP_GATE_TEST_A still holds an .env.example placeholder');
  });

  it('is closed when only one of several is real, and names both states', () => {
    process.env['ZAPP_GATE_TEST_A'] = 'secret-test-real-enough';
    process.env['ZAPP_GATE_TEST_B'] = 'replace-me';
    delete process.env['ZAPP_GATE_TEST_C'];

    const gate = credentialGate(['ZAPP_GATE_TEST_A', 'ZAPP_GATE_TEST_B', 'ZAPP_GATE_TEST_C']);
    expect(gate.present).toBe(false);
    expect(gate.reason).toBe(
      'ZAPP_GATE_TEST_C is unset; ZAPP_GATE_TEST_B still holds an .env.example placeholder',
    );
  });

  it('treats whitespace as empty rather than as a value', () => {
    process.env['ZAPP_GATE_TEST_A'] = '   ';
    expect(credentialGate(['ZAPP_GATE_TEST_A']).present).toBe(false);
  });

  it('opens only when every variable holds something real', () => {
    process.env['ZAPP_GATE_TEST_A'] = 'project-test-11111111-2222-3333-4444-555555555555';
    process.env['ZAPP_GATE_TEST_B'] = 'secret-test-9f0b2c1d4e5a';
    const gate = credentialGate(['ZAPP_GATE_TEST_A', 'ZAPP_GATE_TEST_B']);
    expect(gate.present).toBe(true);
    expect(gate.reason).toBe('');
  });
});

describe('the shipped .env.example', () => {
  const template = readTemplate();

  it('supplies no credential this gate would accept as configured', () => {
    // The regression, pinned at the source. Every one of these is non-empty in
    // the template — which is why the old `!== ''` gates read them as present —
    // and not one of them can sign in to anything.
    for (const name of [
      'STYTCH_PROJECT_ID',
      'STYTCH_SECRET',
      'STYTCH_PUBLIC_TOKEN',
      'FORGEJO_ADMIN_TOKEN',
      'MODAL_TOKEN_ID',
      'MODAL_TOKEN_SECRET',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'PLATFORM_BILLING_STRIPE_SECRET_KEY',
      'PLATFORM_BILLING_STRIPE_WEBHOOK_SECRET',
      'FLEXPRICE_API_KEY',
      'GRAFANA_OTLP_TOKEN',
      'POSTHOG_KEY',
    ]) {
      const value = template[name];
      expect(value, `${name} is missing from .env.example`).toBeDefined();
      expect(
        value === '' || isPlaceholder(value ?? ''),
        `${name} in .env.example would pass a credential gate`,
      ).toBe(true);
    }
  });
});
