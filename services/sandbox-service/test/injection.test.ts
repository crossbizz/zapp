import { describe, expect, it, vi } from 'vitest';
import {
  assertSandboxEnvironment,
  createControlPlaneSecretDecryptClient,
  createSecretStreamRedactor,
  createScopedSecretInjector,
  redactExecResult,
  redactSecretText,
} from '../src/secrets/injector.js';
import { resolveNetworkPolicy } from '../src/network/profiles.js';

const scope = {
  organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
  projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
  environmentId: 'env_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
} as const;

describe('WS-11 scoped secret injection', () => {
  it('calls the audited CP-7 decrypt route with a fresh sandbox-service token', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = createControlPlaneSecretDecryptClient({
      baseUrl: 'https://control.internal',
      serviceTokens: { secret: 's'.repeat(32) },
      fetch: (url, init) => {
        requests.push({ url, init });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              secret: {
                id: 'sec_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
                organizationId: scope.organizationId,
                projectId: scope.projectId,
                environmentId: scope.environmentId,
                name: 'STRIPE_KEY',
                keyVersion: 1,
              },
              value: 'stripe-value',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });

    await expect(
      client.decrypt({
        organizationId: scope.organizationId,
        secretId: 'sec_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
        reason: 'start workspace ws_01J00000000000000000000000',
      }),
    ).resolves.toMatchObject({ value: 'stripe-value' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://control.internal/internal/secrets/decrypt');
    expect(requests[0]?.init.method).toBe('POST');
    expect(new Headers(requests[0]?.init.headers).get('x-zapp-service-token')).toMatch(/^ey/u);
    const requestBody = requests[0]?.init.body;
    if (typeof requestBody !== 'string') throw new Error('decrypt request body was not JSON');
    expect(JSON.parse(requestBody)).toEqual({
      organizationId: scope.organizationId,
      secretId: 'sec_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      reason: 'start workspace ws_01J00000000000000000000000',
    });
  });

  it('decrypts only the requested project/environment scope and keeps values out of agent env', async () => {
    const decrypt = vi.fn(({ secretId }: { readonly secretId: string }) =>
      Promise.resolve({
        secret: {
          id: secretId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: secretId.endsWith('A') ? null : scope.environmentId,
          name: secretId.endsWith('A') ? 'SHARED_KEY' : 'STRIPE_KEY',
          keyVersion: 1,
        },
        value: secretId.endsWith('A') ? 'shared-value' : 'stripe-value',
      }),
    );
    const injector = createScopedSecretInjector({ decrypt });

    const injected = await injector.resolve({
      ...scope,
      secretIds: ['sec_01J8ME7YQZJ2V9Q0X3T5B6K7NA', 'sec_01J8ME7YQZJ2V9Q0X3T5B6K7NB'],
      reason: 'start workspace ws_01J00000000000000000000000',
    });

    expect(injected.values).toEqual({ SHARED_KEY: 'shared-value', STRIPE_KEY: 'stripe-value' });
    expect(injected.agentEnvironment).toEqual({
      ZAPP_SECRET_NAMES: '["SHARED_KEY","STRIPE_KEY"]',
    });
    expect(JSON.stringify(injected.agentEnvironment)).not.toContain('shared-value');
    expect(JSON.stringify(injected.agentEnvironment)).not.toContain('stripe-value');
    expect(decrypt).toHaveBeenCalledTimes(2);
  });

  it('gives an environment-specific secret deterministic precedence over a global secret', async () => {
    const injector = createScopedSecretInjector({
      decrypt: ({ secretId }) =>
        Promise.resolve({
          secret: {
            id: secretId,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: secretId.endsWith('A') ? null : scope.environmentId,
            name: 'SHARED_KEY',
            keyVersion: 1,
          },
          value: secretId.endsWith('A') ? 'global-value' : 'preview-value',
        }),
    });

    await expect(
      injector.resolve({
        ...scope,
        secretIds: ['sec_01J8ME7YQZJ2V9Q0X3T5B6K7NA', 'sec_01J8ME7YQZJ2V9Q0X3T5B6K7NB'],
        reason: 'start workspace ws_01J00000000000000000000000',
      }),
    ).resolves.toMatchObject({ values: { SHARED_KEY: 'preview-value' } });
  });

  it('fails closed on metadata outside the requested scope and reserved platform names', async () => {
    const mismatched = createScopedSecretInjector({
      decrypt: () =>
        Promise.resolve({
          secret: {
            id: 'sec_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
            organizationId: scope.organizationId,
        projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NZ',
            environmentId: scope.environmentId,
            name: 'SAFE_KEY',
            keyVersion: 1,
          },
          value: 'secret',
        }),
    });
    await expect(
      mismatched.resolve({
        ...scope,
        secretIds: ['sec_01J8ME7YQZJ2V9Q0X3T5B6K7NA'],
        reason: 'start workspace ws_01J00000000000000000000000',
      }),
    ).rejects.toThrow('scope');

    const reserved = createScopedSecretInjector({
      decrypt: () =>
        Promise.resolve({
          secret: {
            id: 'sec_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            name: 'DATABASE_URL',
            keyVersion: 1,
          },
          value: 'secret',
        }),
    });
    await expect(
      reserved.resolve({
        ...scope,
        secretIds: ['sec_01J8ME7YQZJ2V9Q0X3T5B6K7NA'],
        reason: 'start workspace ws_01J00000000000000000000000',
      }),
    ).rejects.toThrow('reserved');
  });

  it('redacts every registered value and rejects forbidden sandbox environment keys', () => {
    expect(
      redactSecretText('out=stripe-value shared=shared-value', {
        STRIPE_KEY: 'stripe-value',
        SHARED_KEY: 'shared-value',
      }),
    ).toBe('out=[secret:STRIPE_KEY] shared=[secret:SHARED_KEY]');

    expect(() => {
      assertSandboxEnvironment({
        ZAPP_AGENT_TOKEN: 'name-only-token',
        NPM_CONFIG_STORE_DIR: '/cache/pnpm',
        PNPM_STORE_DIR: '/cache/pnpm',
        ZAPP_SECRET_NAMES: '["STRIPE_KEY"]',
      });
    }).not.toThrow();
    for (const name of [
      'MODAL_TOKEN_ID',
      'DATABASE_URL',
      'SERVICE_TOKEN_SECRET',
      'STYTCH_SECRET',
      'GRAFANA_TOKEN',
      'FLEXPRICE_API_KEY',
    ]) {
      expect(() => {
        assertSandboxEnvironment({ [name]: 'forbidden' });
      }).toThrow(name);
    }

    expect(
      redactExecResult(
        {
          exitCode: 0,
          stdout: 'stripe-value',
          stderr: 'shared-value',
          durationMs: 1,
          truncated: false,
        },
        { STRIPE_KEY: 'stripe-value', SHARED_KEY: 'shared-value' },
      ),
    ).toEqual({
      exitCode: 0,
      stdout: '[secret:STRIPE_KEY]',
      stderr: '[secret:SHARED_KEY]',
      durationMs: 1,
      truncated: false,
    });
    const streamRedactor = createSecretStreamRedactor({ STRIPE_KEY: 'stripe-value' });
    expect(streamRedactor.push('before str')).toBe('before ');
    expect(streamRedactor.push('ipe-val')).toBe('');
    expect(streamRedactor.push('ue after')).toBe('[secret:STRIPE_KEY] after');
    expect(streamRedactor.finish()).toBe('');
  });
});

describe('WS-11 network profiles', () => {
  it('resolves strict domain policy and records the requested defense-in-depth profile', () => {
    expect(resolveNetworkPolicy('dependency_install', ['api.stripe.com'])).toEqual({
      profile: 'dependency_install',
      outboundDomains: [
        'api.stripe.com',
        'github.com',
        'registry.npmjs.org',
      ],
      blockAll: false,
    });
    expect(resolveNetworkPolicy('build_test', ['api.stripe.com'])).toEqual({
      profile: 'build_test',
      outboundDomains: ['api.stripe.com'],
      blockAll: false,
    });
    expect(resolveNetworkPolicy('restricted_verification', [])).toEqual({
      profile: 'restricted_verification',
      outboundDomains: [],
      blockAll: true,
    });
  });
});
