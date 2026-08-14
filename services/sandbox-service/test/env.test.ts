import { SERVICE_TOKEN_ISSUER } from '@zapp/config';
import { describe, expect, it } from 'vitest';

import { loadSandboxServiceEnv } from '../src/env.js';

function validEnvironment(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    SANDBOX_HOST: '127.0.0.1',
    SANDBOX_PORT: '4400',
    DATABASE_URL: 'postgres://zapp:zapp@127.0.0.1:5432/zapp',
    CONTROL_API_INTERNAL_URL: 'http://127.0.0.1:4000',
    GIT_SERVICE_URL: 'http://127.0.0.1:4500',
    SERVICE_TOKEN_SECRET: 's'.repeat(64),
    SERVICE_TOKEN_ISSUER,
    MODAL_TOKEN_ID: 'ak-test-runtime',
    MODAL_TOKEN_SECRET: 'as-test-runtime',
    MODAL_ENVIRONMENT: 'dev',
    SANDBOX_GLOBAL_LIMIT: '12',
    SANDBOX_OWNER_ID: 'sandbox-local-1',
  };
}

describe('sandbox-service environment', () => {
  it('parses the required bind, boundary, provider, and governor configuration', () => {
    expect(loadSandboxServiceEnv(validEnvironment())).toMatchObject({
      nodeEnv: 'test',
      host: '127.0.0.1',
      port: 4400,
      databaseUrl: 'postgres://zapp:zapp@127.0.0.1:5432/zapp',
      controlApiInternalUrl: 'http://127.0.0.1:4000',
      gitServiceUrl: 'http://127.0.0.1:4500',
      modal: {
        environment: 'dev',
        credentials: { tokenId: 'ak-test-runtime', tokenSecret: 'as-test-runtime' },
      },
      globalLimit: 12,
      ownerId: 'sandbox-local-1',
    });
  });

  it.each([
    'NODE_ENV',
    'SANDBOX_HOST',
    'SANDBOX_PORT',
    'DATABASE_URL',
    'CONTROL_API_INTERNAL_URL',
    'GIT_SERVICE_URL',
    'SERVICE_TOKEN_SECRET',
    'SERVICE_TOKEN_ISSUER',
    'MODAL_TOKEN_ID',
    'MODAL_TOKEN_SECRET',
    'MODAL_ENVIRONMENT',
    'SANDBOX_GLOBAL_LIMIT',
    'SANDBOX_OWNER_ID',
  ])('names a missing %s without exposing another value', (name) => {
    const source = Object.fromEntries(
      Object.entries(validEnvironment()).filter(([key]) => key !== name),
    );
    expect(() => loadSandboxServiceEnv(source)).toThrow(`Invalid environment: ${name}`);
    try {
      loadSandboxServiceEnv(source);
    } catch (error) {
      expect(String(error)).not.toContain('as-test-runtime');
    }
  });

  it.each(['SERVICE_TOKEN_SECRET', 'MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'])(
    'rejects a committed placeholder in %s',
    (name) => {
      expect(() =>
        loadSandboxServiceEnv({ ...validEnvironment(), [name]: 'replace-me' }),
      ).toThrow(`Invalid environment: ${name}`);
    },
  );

  it('requires the code-owned service-token issuer', () => {
    expect(() =>
      loadSandboxServiceEnv({
        ...validEnvironment(),
        SERVICE_TOKEN_ISSUER: 'another-issuer',
      }),
    ).toThrow('Invalid environment: SERVICE_TOKEN_ISSUER');
  });
});
