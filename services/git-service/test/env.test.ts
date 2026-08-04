import { describe, expect, it } from 'vitest';

import { loadEnv, loadForgejoEnv } from '../src/env.js';
import { DEFAULT_SWEEP_INTERVAL_MS } from '../src/sweep.js';

const FORGEJO = {
  FORGEJO_URL: 'http://localhost:3300',
  FORGEJO_ADMIN_TOKEN: 'a'.repeat(40),
};

describe('loadEnv', () => {
  it('boots with an empty environment', () => {
    // The process-shape variables all have defaults, so `pnpm start` works
    // without a file. Nothing here is a secret; everything that is has its own
    // loader below.
    expect(loadEnv({})).toEqual({
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: 4500,
      LOG_LEVEL: 'info',
      // The safe value is the one that runs: a deployment that says nothing
      // about the sweep still expires its repository tokens (GIT-3 fix round 1).
      TOKEN_SWEEP_INTERVAL_MS: DEFAULT_SWEEP_INTERVAL_MS,
    });
  });

  it('treats an unset NODE_ENV as production', () => {
    // Same rule as the control plane's: every switch that reads it is safer in
    // its production position, and an unset variable must never be what turns a
    // relaxation on.
    expect(loadEnv({}).NODE_ENV).toBe('production');
  });

  it('refuses a sweep interval longer than the longest token lives', () => {
    // A sweep slower than `MAX_TOKEN_TTL_SECONDS` would let *every* token
    // outlive its deadline, which is the failure the timer exists to prevent.
    expect(() => loadEnv({ TOKEN_SWEEP_INTERVAL_MS: '900000' })).toThrow(
      'Invalid environment: TOKEN_SWEEP_INTERVAL_MS',
    );
    expect(loadEnv({ TOKEN_SWEEP_INTERVAL_MS: '5000' }).TOKEN_SWEEP_INTERVAL_MS).toBe(5_000);
  });

  it('names an invalid variable and never its value', () => {
    expect(() => loadEnv({ PORT: 'not-a-port' })).toThrow('Invalid environment: PORT');
    expect(() => loadEnv({ PORT: 'not-a-port' })).not.toThrow(/not-a-port/);
  });
});

describe('loadForgejoEnv', () => {
  it('requires both the URL and the token', () => {
    expect(() => loadForgejoEnv({})).toThrow(
      'Invalid environment: FORGEJO_URL, FORGEJO_ADMIN_TOKEN',
    );
  });

  it('never echoes the token, even when it is the thing that failed', () => {
    const secret = 'super-secret-token';
    // The failure is the URL, and the message must still not carry the token
    // that happened to be in the same object.
    expect(() => loadForgejoEnv({ FORGEJO_URL: 'nonsense', FORGEJO_ADMIN_TOKEN: secret })).toThrow(
      'Invalid environment: FORGEJO_URL',
    );
    try {
      loadForgejoEnv({ FORGEJO_URL: 'nonsense', FORGEJO_ADMIN_TOKEN: secret });
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('strips trailing slashes so paths do not double up', () => {
    // `${base}/api/v1` against `http://host/` is `http://host//api/v1`, which
    // some proxies answer with a redirect and some with a 404.
    expect(loadForgejoEnv({ ...FORGEJO, FORGEJO_URL: 'http://localhost:3300//' }).baseUrl).toBe(
      'http://localhost:3300',
    );
  });

  it('defaults the deadline to half of the control plane’s', () => {
    // `GIT_CREATE_DEADLINE_MS` is 10s and is measured by the *caller*, which is
    // holding a PostgreSQL transaction open for the whole round trip. This
    // service's own deadline has to expire first, or the control plane gives up
    // while a repository is still being created and nothing is left to record it.
    expect(loadForgejoEnv(FORGEJO).timeoutMs).toBe(5_000);
  });

  it('refuses a deadline long enough to outlive the caller', () => {
    expect(() => loadForgejoEnv({ ...FORGEJO, FORGEJO_TIMEOUT_MS: '600000' })).toThrow(
      'Invalid environment: FORGEJO_TIMEOUT_MS',
    );
  });
});
