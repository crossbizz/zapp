import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineEnv } from '../src/env.js';
import { z } from 'zod';

describe('defineEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('parses valid env and strips unknown keys', () => {
    const env = defineEnv(z.object({ PORT: z.coerce.number() }), { PORT: '4000', OTHER: 'x' });
    expect(env).toEqual({ PORT: 4000 });
  });
  it('throws with the missing key names, never values', () => {
    expect(() => defineEnv(z.object({ SECRET_KEY: z.string() }), {})).toThrowError(/SECRET_KEY/);
  });
  it('names a key holding an invalid value without leaking the value', () => {
    // Matching on an Error instance asserts message *equality*, so this fails if
    // anything beyond the key name — such as the secret itself — is appended.
    const secret = 'sk-live-must-never-appear';
    expect(() =>
      defineEnv(z.object({ SECRET_KEY: z.string().min(64) }), { SECRET_KEY: secret }),
    ).toThrowError(new Error('Invalid environment: SECRET_KEY'));
  });
  it('joins several offending key names with a comma', () => {
    expect(() => defineEnv(z.object({ A: z.string(), B: z.string() }), {})).toThrowError(
      new Error('Invalid environment: A, B'),
    );
  });
  it('lists a key once even when it fails several checks', () => {
    // `.min(10)` and `.startsWith()` both fail here, producing two issues that
    // share the path ['TOKEN'] — the name must not be repeated.
    const schema = z.object({ TOKEN: z.string().min(10).startsWith('sk-') });
    expect(() => defineEnv(schema, { TOKEN: 'nope' })).toThrowError(
      new Error('Invalid environment: TOKEN'),
    );
  });
  it('reports <schema> when the failure belongs to no single key', () => {
    const schema = z
      .object({ A: z.string(), B: z.string() })
      .refine((env) => env.A !== env.B, { message: 'A and B must differ' });
    expect(() => defineEnv(schema, { A: 'same', B: 'same' })).toThrowError(
      new Error('Invalid environment: <schema>'),
    );
  });
  it('reads process.env when no source is given', () => {
    vi.stubEnv('ZAPP_TEST_PORT', '4000');
    expect(defineEnv(z.object({ ZAPP_TEST_PORT: z.coerce.number() }))).toEqual({
      ZAPP_TEST_PORT: 4000,
    });
  });
});
