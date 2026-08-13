import { describe, expect, it } from 'vitest';

import { loadEnv, loadServiceTokenConfig } from '../src/env.js';

describe('release-service environment', () => {
  it('loads the listening address and refuses an absent service credential', () => {
    expect(loadEnv({})).toEqual({ NODE_ENV: 'production', HOST: '0.0.0.0', PORT: 4300 });
    expect(loadServiceTokenConfig({ SERVICE_TOKEN_SECRET: 's'.repeat(64) })).toEqual({
      secret: 's'.repeat(64),
    });
    expect(() => loadServiceTokenConfig({})).toThrow('SERVICE_TOKEN_SECRET');
  });
});
