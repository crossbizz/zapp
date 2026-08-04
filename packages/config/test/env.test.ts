import { describe, expect, it } from 'vitest';
import { defineEnv } from '../src/env.js';
import { z } from 'zod';

describe('defineEnv', () => {
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
});
