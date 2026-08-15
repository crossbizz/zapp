import { SERVICE_TOKEN_ISSUER } from '@zapp/config';
import { describe, expect, it } from 'vitest';

import { loadSandboxServiceEnv } from '../src/env.js';

function localDatabaseUrl(): string {
  const url = new URL('postgres://127.0.0.1:5432/zapp');
  url.username = 'zapp';
  url.password = 'zapp';
  return url.toString();
}

function validEnvironment(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    SANDBOX_HOST: '127.0.0.1',
    SANDBOX_PORT: '4400',
    DATABASE_URL: localDatabaseUrl(),
    CONTROL_API_INTERNAL_URL: 'http://127.0.0.1:4000',
    GIT_SERVICE_URL: 'http://127.0.0.1:4500',
    GIT_CLONE_BASE_URL: 'https://git-edge.example.test/root/',
    SERVICE_TOKEN_SECRET: 's'.repeat(64),
    SERVICE_TOKEN_ISSUER,
    SANDBOX_PROVIDER: 'modal',
    MODAL_TOKEN_ID: 'ak-test-runtime',
    MODAL_TOKEN_SECRET: 'as-test-runtime',
    MODAL_ENVIRONMENT: 'dev',
    SANDBOX_GLOBAL_LIMIT: '12',
    SANDBOX_LOCAL_ORGANIZATION_LIMIT: '10',
    SANDBOX_OWNER_ID: 'sandbox-local-1',
  };
}

describe('sandbox-service environment', () => {
  it('parses the required bind, boundary, provider, and governor configuration', () => {
    expect(loadSandboxServiceEnv(validEnvironment())).toMatchObject({
      nodeEnv: 'test',
      host: '127.0.0.1',
      port: 4400,
      databaseUrl: localDatabaseUrl(),
      controlApiInternalUrl: 'http://127.0.0.1:4000',
      gitServiceUrl: 'http://127.0.0.1:4500',
      gitCloneBaseUrl: 'https://git-edge.example.test/root',
      provider: 'modal',
      modal: {
        environment: 'dev',
        credentials: { tokenId: 'ak-test-runtime', tokenSecret: 'as-test-runtime' },
      },
      globalLimit: 12,
      ownerId: 'sandbox-local-1',
    });
  });

  it('accepts Docker in development without reading Modal credentials', () => {
    const source = validEnvironment();
    delete source['MODAL_TOKEN_ID'];
    delete source['MODAL_TOKEN_SECRET'];

    expect(
      loadSandboxServiceEnv({
        ...source,
        NODE_ENV: 'development',
        SANDBOX_PROVIDER: 'docker',
      }),
    ).toMatchObject({
      nodeEnv: 'development',
      provider: 'docker',
      localOrganizationLimit: 10,
      modal: { environment: 'dev' },
    });
  });

  it('rejects Docker before a production process can listen', () => {
    expect(() =>
      loadSandboxServiceEnv({
        ...validEnvironment(),
        NODE_ENV: 'production',
        SANDBOX_PROVIDER: 'docker',
      }),
    ).toThrow('Invalid environment: SANDBOX_PROVIDER');
  });

  it.each([
    'NODE_ENV',
    'SANDBOX_HOST',
    'SANDBOX_PORT',
    'DATABASE_URL',
    'CONTROL_API_INTERNAL_URL',
    'GIT_SERVICE_URL',
    'GIT_CLONE_BASE_URL',
    'SERVICE_TOKEN_SECRET',
    'SERVICE_TOKEN_ISSUER',
    'SANDBOX_PROVIDER',
    'MODAL_TOKEN_ID',
    'MODAL_TOKEN_SECRET',
    'MODAL_ENVIRONMENT',
    'SANDBOX_GLOBAL_LIMIT',
    'SANDBOX_LOCAL_ORGANIZATION_LIMIT',
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

  it('requires Modal credentials only when the Modal provider is selected', () => {
    const source = validEnvironment();
    delete source['MODAL_TOKEN_SECRET'];
    expect(() => loadSandboxServiceEnv(source)).toThrow(
      'Invalid environment: MODAL_TOKEN_SECRET',
    );
  });

  it('requires the code-owned service-token issuer', () => {
    expect(() =>
      loadSandboxServiceEnv({
        ...validEnvironment(),
        SERVICE_TOKEN_ISSUER: 'another-issuer',
      }),
    ).toThrow('Invalid environment: SERVICE_TOKEN_ISSUER');
  });
});
