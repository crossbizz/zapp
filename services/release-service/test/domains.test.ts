import { describe, expect, it } from 'vitest';

import {
  createFlyCertificateDomainAdapter,
  createDomainService,
  type DomainDependencies,
  type DomainRequest,
} from '../src/domains/service.js';
import { flyAppName } from '../src/providers/fly.js';

const ORGANIZATION_ID = 'org_01J00000000000000000000000';
const PROJECT_ID = 'proj_01J00000000000000000000000';
const ENVIRONMENT_ID = 'env_01J00000000000000000000000';
const OPERATION_KEY = `op_${'8'.repeat(64)}`;

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function request(hostname = 'app.example.com'): DomainRequest {
  return {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    hostname,
    operationKey: OPERATION_KEY,
  };
}

function harness(
  input: {
    readonly providerId?: 'fly' | 'vercel';
    readonly hostnameKind?: 'apex' | 'www' | 'subdomain';
    readonly dnsStates?: readonly ('pending' | 'matched' | 'wrong_record' | 'caa_blocked')[];
    readonly providerStates?: readonly ('verifying' | 'active' | 'failed')[];
    readonly providerFailureCause?: 'wrong_record' | 'caa' | 'rate_limit';
    readonly claimOperationKey?: string;
    readonly claimFingerprint?: string;
  } = {},
) {
  const providerId = input.providerId ?? 'fly';
  const calls: string[] = [];
  let row: Record<string, unknown> | undefined;
  let dnsIndex = 0;
  let providerIndex = 0;

  const providerResult =
    providerId === 'fly'
      ? {
          providerDomainReference: 'fly-cert-app-example-com',
          status: 'pending_dns' as const,
          dnsInstructions: [
            { type: 'A' as const, name: '@', value: '66.241.124.31' },
            {
              type: 'TXT' as const,
              name: '_acme-challenge.app',
              value: 'fly-validation-token',
            },
          ],
        }
      : {
          providerDomainReference: 'vercel-domain-app-example-com',
          status: 'pending_dns' as const,
          dnsInstructions: [
            { type: 'CNAME' as const, name: 'app', value: 'cname.vercel-dns.com' },
            {
              type: 'TXT' as const,
              name: '_vercel.app',
              value: 'vc-domain-verify=verification-token',
            },
          ],
        };

  const dependencies: DomainDependencies = {
    context: {
      resolve() {
        return Promise.resolve({ providerId });
      },
    },
    store: {
      get() {
        return Promise.resolve(row);
      },
      claim(value) {
        calls.push('claim');
        row ??= {
          ...value,
          operationKey: input.claimOperationKey ?? value.operationKey,
          fingerprint: input.claimFingerprint ?? value.fingerprint,
          providerDomainReference: null,
          verificationAttempt: 0,
        };
        return Promise.resolve(row);
      },
      update(value) {
        if (
          row?.status !== value.expectedStatus ||
          row.verificationAttempt !== value.expectedVerificationAttempt
        ) {
          throw new Error('stale domain update');
        }
        calls.push(`store:${value.status}`);
        row = {
          ...row,
          organizationId: value.organizationId,
          projectId: value.projectId,
          environmentId: value.environmentId,
          hostname: value.hostname,
          providerDomainReference: value.providerDomainReference,
          status: value.status,
          dnsInstructions: value.dnsInstructions,
          routing: value.routing,
          detail: value.detail,
          verificationAttempt: value.verificationAttempt,
        };
        return Promise.resolve(row);
      },
    },
    dns: {
      classify() {
        return Promise.resolve({
          kind: input.hostnameKind ?? 'subdomain',
          apexHostname: 'example.com',
          wwwHostname: 'www.example.com',
        });
      },
      inspect() {
        const state = input.dnsStates?.[dnsIndex] ?? 'matched';
        dnsIndex += 1;
        calls.push(`dns:${state}`);
        return Promise.resolve({ state });
      },
    },
    provider: {
      configure(value) {
        calls.push(`configure:${value.providerId}`);
        return Promise.resolve(providerResult);
      },
      verify() {
        const status = input.providerStates?.[providerIndex] ?? 'active';
        providerIndex += 1;
        calls.push(`verify:${status}`);
        return Promise.resolve({
          status,
          ...(status === 'failed'
            ? { failureCause: input.providerFailureCause ?? 'rate_limit' }
            : {}),
        });
      },
    },
  };

  return { calls, dependencies, row: () => row };
}

describe('DEP-10 custom domains', () => {
  it.each([
    [
      'fly',
      {
        hostname: 'app.example.com',
        environmentId: ENVIRONMENT_ID,
        status: 'pending_dns',
        dnsInstructions: [
          { type: 'A', name: '@', value: '66.241.124.31' },
          {
            type: 'TXT',
            name: '_acme-challenge.app',
            value: 'fly-validation-token',
          },
        ],
        routing: {
          kind: 'subdomain',
          apexHostname: 'example.com',
          wwwHostname: 'www.example.com',
          recommendation:
            'This subdomain is independent. Add the displayed records; apex and www can be added separately.',
        },
        ssl: { managed: true, status: 'pending' },
      },
    ],
    [
      'vercel',
      {
        hostname: 'app.example.com',
        environmentId: ENVIRONMENT_ID,
        status: 'pending_dns',
        dnsInstructions: [
          { type: 'CNAME', name: 'app', value: 'cname.vercel-dns.com' },
          {
            type: 'TXT',
            name: '_vercel.app',
            value: 'vc-domain-verify=verification-token',
          },
        ],
        routing: {
          kind: 'subdomain',
          apexHostname: 'example.com',
          wwwHostname: 'www.example.com',
          recommendation:
            'This subdomain is independent. Add the displayed records; apex and www can be added separately.',
        },
        ssl: { managed: true, status: 'pending' },
      },
    ],
  ] as const)('returns the %s DNS instruction payload', async (providerId, snapshot) => {
    const fixture = harness({ providerId });
    const service = createDomainService(fixture.dependencies);

    await expect(service.configure(request())).resolves.toEqual(snapshot);
    expect(fixture.calls).toEqual(['claim', `configure:${providerId}`, 'store:pending_dns']);
    expect(fixture.row()).toMatchObject({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      providerId,
      hostname: 'app.example.com',
    });
  });

  it.each([
    [
      'example.com',
      'apex',
      'Use the displayed apex records. Add www separately and redirect one hostname to the other.',
    ],
    [
      'www.example.com',
      'www',
      'Use the displayed www records. Add the apex separately and redirect one hostname to the other.',
    ],
  ] as const)('documents apex and www handling for %s', async (hostname, hostnameKind, message) => {
    const fixture = harness({ hostnameKind });
    const service = createDomainService(fixture.dependencies);

    await expect(service.configure(request(hostname))).resolves.toMatchObject({
      routing: { kind: hostnameKind, recommendation: message },
    });
  });

  it('moves pending DNS through provider verification to active SSL', async () => {
    const fixture = harness({
      dnsStates: ['pending', 'matched', 'matched'],
      providerStates: ['verifying', 'active'],
    });
    const service = createDomainService(fixture.dependencies);
    await service.configure(request());

    await expect(service.poll(request())).resolves.toMatchObject({
      status: 'pending_dns',
      ssl: { managed: true, status: 'pending' },
    });
    await expect(service.poll(request())).resolves.toMatchObject({
      status: 'verifying',
      ssl: { managed: true, status: 'pending' },
    });
    await expect(service.poll(request())).resolves.toMatchObject({
      status: 'active',
      ssl: { managed: true, status: 'active' },
    });
    expect(fixture.calls).toEqual([
      'claim',
      'configure:fly',
      'store:pending_dns',
      'dns:pending',
      'dns:matched',
      'store:verifying',
      'verify:verifying',
      'store:verifying',
      'dns:matched',
      'verify:active',
      'store:active',
    ]);
  });

  it.each([
    ['wrong_record', 'DNS records do not match the displayed values.'],
    ['caa_blocked', 'CAA records do not allow the deployment provider to issue a certificate.'],
  ] as const)('fails with a user-readable %s DNS cause', async (state, detail) => {
    const fixture = harness({ dnsStates: [state] });
    const service = createDomainService(fixture.dependencies);
    await service.configure(request());

    await expect(service.poll(request())).resolves.toMatchObject({
      status: 'failed',
      detail,
      ssl: { managed: true, status: 'failed' },
    });
  });

  it('maps provider rate limits to a user-readable failed state', async () => {
    const fixture = harness({ providerStates: ['failed'], providerFailureCause: 'rate_limit' });
    const service = createDomainService(fixture.dependencies);
    await service.configure(request());

    await expect(service.poll(request())).resolves.toMatchObject({
      status: 'failed',
      detail: 'Domain verification is temporarily rate-limited. Try again later.',
      ssl: { managed: true, status: 'failed' },
    });
  });

  it('replays a keyed configuration without a second provider mutation', async () => {
    const fixture = harness();
    const service = createDomainService(fixture.dependencies);

    const first = await service.configure(request());
    await expect(service.configure(request())).resolves.toEqual(first);
    expect(fixture.calls.filter((call) => call.startsWith('configure:'))).toEqual([
      'configure:fly',
    ]);
  });

  it('rejects reuse of an operation key for a different configuration fingerprint', async () => {
    const fixture = harness({ claimFingerprint: '1'.repeat(64) });
    const service = createDomainService(fixture.dependencies);

    await expect(service.configure(request())).rejects.toMatchObject({
      code: 'domain_conflict',
      statusCode: 409,
    });
    expect(fixture.calls).toEqual(['claim']);
  });

  it('does not join an in-progress configuration owned by another operation', async () => {
    const fixture = harness({ claimOperationKey: `op_${'7'.repeat(64)}` });
    const service = createDomainService(fixture.dependencies);

    await expect(service.configure(request())).rejects.toMatchObject({
      code: 'domain_conflict',
      statusCode: 409,
    });
    expect(fixture.calls).toEqual(['claim']);
  });

  it('uses the Fly ACME certificates API and returns guided CNAME plus ownership TXT records', async () => {
    const calls: {
      readonly method: string;
      readonly url: string;
      readonly authorization: string | null;
    }[] = [];
    const responses = [
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
      new Response(
        JSON.stringify({
          hostname: 'app.example.com',
          configured: false,
          acme_requested: true,
          status: 'pending_validation',
          rate_limited_until: null,
          validation: {
            dns_configured: false,
            alpn_configured: false,
            http_configured: false,
            ownership_txt_configured: false,
          },
          dns_requirements: {
            a: ['137.66.10.20'],
            aaaa: ['2a09:8280:1::1'],
            cname: 'zapp-app.fly.dev',
            acme_challenge: {
              name: '_acme-challenge.app.example.com',
              target: 'app.example.com.flydns.net',
            },
            ownership: {
              name: '_fly-ownership.app.example.com',
              app_value: 'app-token',
              org_value: 'org-token',
            },
          },
          validation_errors: [],
        }),
        { status: 201 },
      ),
    ];
    const adapter = createFlyCertificateDomainAdapter({
      apiBaseUrl: 'https://fly.test/v1',
      apiToken: 'fly-secret-token',
      classifyHostname: () => Promise.resolve({ kind: 'subdomain' }),
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          method: init?.method ?? 'GET',
          url: requestUrl(url),
          authorization: headers.get('authorization'),
        });
        const response = responses.shift();
        if (response === undefined) throw new Error('unexpected Fly request');
        return Promise.resolve(response);
      },
    });

    await expect(
      adapter.configure({
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        hostname: 'app.example.com',
      }),
    ).resolves.toEqual({
      hostname: 'app.example.com',
      status: 'pending_dns',
      dnsInstructions: [
        { type: 'CNAME', name: 'app.example.com', value: 'zapp-app.fly.dev' },
        {
          type: 'TXT',
          name: '_fly-ownership.app.example.com',
          value: 'app-token;org-token',
        },
      ],
    });
    const appName = flyAppName(PROJECT_ID, ENVIRONMENT_ID);
    expect(calls).toEqual([
      {
        method: 'GET',
        url: `https://fly.test/v1/apps/${appName}/certificates/app.example.com`,
        authorization: 'Bearer fly-secret-token',
      },
      {
        method: 'POST',
        url: `https://fly.test/v1/apps/${appName}/certificates/acme`,
        authorization: 'Bearer fly-secret-token',
      },
    ]);
  });

  it('polls the Fly certificate check endpoint and reports provider-managed SSL active', async () => {
    const appName = flyAppName(PROJECT_ID, ENVIRONMENT_ID);
    const calls: string[] = [];
    const adapter = createFlyCertificateDomainAdapter({
      apiBaseUrl: 'https://fly.test/v1',
      apiToken: 'fly-secret-token',
      classifyHostname: () => Promise.resolve({ kind: 'apex' }),
      fetch: (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${requestUrl(url)}`);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              hostname: 'example.com',
              configured: true,
              acme_requested: true,
              status: 'active',
              rate_limited_until: null,
              validation: {
                dns_configured: true,
                alpn_configured: true,
                http_configured: true,
                ownership_txt_configured: true,
              },
              dns_requirements: {
                a: ['137.66.10.20'],
                aaaa: ['2a09:8280:1::1'],
                cname: 'zapp-app.fly.dev',
                ownership: {
                  name: '_fly-ownership.example.com',
                  app_value: 'app-token',
                  org_value: 'org-token',
                },
              },
              validation_errors: [],
            }),
            { status: 200 },
          ),
        );
      },
    });

    await expect(
      adapter.verify({
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        hostname: 'example.com',
      }),
    ).resolves.toEqual({
      hostname: 'example.com',
      status: 'active',
      dnsInstructions: [
        { type: 'A', name: 'example.com', value: '137.66.10.20' },
        {
          type: 'TXT',
          name: '_fly-ownership.example.com',
          value: 'app-token;org-token',
        },
      ],
    });
    expect(calls).toEqual([
      `POST https://fly.test/v1/apps/${appName}/certificates/example.com/check`,
    ]);
  });
});
