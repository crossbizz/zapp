import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { astToString, default as openapiTypescript } from 'openapi-typescript';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppInstance } from '../src/app.js';
import type { AuthIdentity } from '../src/auth/port.js';
import { PUBLIC_API_OPERATIONS } from '../../../packages/api-client/src/generated-operations.js';
import {
  createInMemoryPreviewSessionStore,
  createInMemoryPreviewShareStore,
} from '../src/routes/preview.js';
import {
  buildHarness,
  cookieJar,
  cookiesOf,
  TEST_PRICING,
  type Harness,
} from './support/harness.js';
import { createInMemoryGitHubAuthorizationStateStore } from '../src/integrations/github/store.js';
import { createInMemoryGitHubWebhookStore } from '../src/integrations/github/queue.js';
import type { paths as GeneratedPaths } from '../../../packages/api-client/src/generated.js';
import { createInMemoryNotificationState } from '../src/notifications/service.js';
import { createInMemoryIncidentStore } from '../src/routes/incidents.js';

const GENERATED_TYPES = resolve(
  import.meta.dirname,
  '../../../packages/api-client/src/generated.ts',
);
const GENERATED_OPERATIONS = resolve(
  import.meta.dirname,
  '../../../packages/api-client/src/generated-operations.ts',
);
const OPENAPI_DOCUMENT = resolve(import.meta.dirname, '../../../packages/api-client/openapi.json');
const apps: AppInstance[] = [];
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

interface OpenApiOperation {
  parameters?: {
    in?: string;
    name?: string;
    required?: boolean;
    schema?: Record<string, unknown>;
  }[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  responses?: Record<
    string,
    {
      content?: Record<string, unknown>;
      headers?: Record<string, { required?: boolean }>;
    }
  >;
  security?: readonly Record<string, readonly string[]>[];
}

function documentedHarness(): Harness {
  const built = buildHarness({
    admin: { enabled: false, staffUserIds: [] },
    incidentStore: createInMemoryIncidentStore(),
    incidentWebhookSecret: 'openapi-grafana-secret-that-is-long-enough',
    notificationState: createInMemoryNotificationState(),
    usageLedger: {
      recordUsage: () => Promise.reject(new Error('OpenAPI must not record usage.')),
      getUsageSummary: () => Promise.reject(new Error('OpenAPI must not read usage.')),
    },
    creditBalance: {
      availableCredits: () => Promise.reject(new Error('OpenAPI must not read credits.')),
      requireRunAdmission: () => Promise.reject(new Error('OpenAPI must not admit runs.')),
    },
    tenantDb: () => {
      throw new Error('OpenAPI generation must not access the tenant database.');
    },
    preview: {
      shares: createInMemoryPreviewShareStore(),
      sessions: createInMemoryPreviewSessionStore(),
      proxy: {
        request: () => Promise.reject(new Error('OpenAPI must not proxy preview traffic.')),
        openWebSocket: () => Promise.reject(new Error('OpenAPI must not proxy WebSockets.')),
      },
      signingKey: Buffer.alloc(32),
      keyVersion: 1,
      appBaseUrl: new URL('https://app.zapp.test'),
      previewBaseDomain: 'preview.zapp.test',
    },
    localAgent: {
      sessions: {
        ensure: () => Promise.reject(new Error('OpenAPI must not create local sessions.')),
        get: () => Promise.reject(new Error('OpenAPI must not read local sessions.')),
      },
      gateway: { async *stream() {} },
    },
    github: {
      appSlug: 'zapp-build-test',
      stateStore: createInMemoryGitHubAuthorizationStateStore(),
      provider: {
        completeInstallation: () => Promise.reject(new Error('OpenAPI must not call GitHub.')),
        listRepositories: () => Promise.reject(new Error('OpenAPI must not call GitHub.')),
        listBranches: () => Promise.reject(new Error('OpenAPI must not call GitHub.')),
      },
    },
    githubWebhook: {
      secret: 'openapi-test-secret',
      store: createInMemoryGitHubWebhookStore(),
    },
    billing: {
      stripe: {
        createCheckout: () =>
          Promise.reject(new Error('OpenAPI must not create checkout sessions.')),
        createPortal: () => Promise.reject(new Error('OpenAPI must not create portal sessions.')),
        updateSeats: () => Promise.reject(new Error('OpenAPI must not update seats.')),
        createProduct: () => Promise.reject(new Error('OpenAPI must not create products.')),
        createMonthlyPrice: () => Promise.reject(new Error('OpenAPI must not create prices.')),
        verifyWebhookEndpoint: () =>
          Promise.reject(new Error('OpenAPI must not inspect webhooks.')),
      },
      store: {
        status: () => Promise.reject(new Error('OpenAPI must not read billing status.')),
        syncSubscription: () => Promise.reject(new Error('OpenAPI must not sync subscriptions.')),
        findOrganizationByCustomer: () =>
          Promise.reject(new Error('OpenAPI must not find customers.')),
        markPaymentFailed: () => Promise.reject(new Error('OpenAPI must not mark dunning.')),
        clearDunning: () => Promise.reject(new Error('OpenAPI must not clear dunning.')),
        mirrorCreditGrant: () => Promise.reject(new Error('OpenAPI must not grant credits.')),
        ledgerCostUsd: () => Promise.reject(new Error('OpenAPI must not read usage cost.')),
        downgradeExpiredDunning: () => Promise.resolve(0),
      },
      prices: { builder: 'price_builder123', studio: 'price_studio123' },
      appBaseUrl: 'https://app.zapp.test',
      webhook: {
        handle: () => Promise.reject(new Error('OpenAPI must not process Stripe webhooks.')),
      },
      topups: {
        stripe: {
          createCreditCheckout: () =>
            Promise.reject(new Error('OpenAPI must not create credit checkout sessions.')),
        },
        packs: TEST_PRICING.creditPacks ?? {},
        prices: { starter: 'price_starter123' },
        pricing: TEST_PRICING,
      },
    },
  });
  apps.push(built.app);
  return built;
}

function documentedApp(): AppInstance {
  return documentedHarness().app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('generated API types', () => {
  it('publishes the versioned incident list/report APIs and Fix seed', async () => {
    const app = documentedHarness().app;
    apps.push(app);
    await app.ready();
    const document = app.swagger() as { paths: Record<string, OpenApiOperation> };
    const incidentPath = document.paths['/v1/projects/{projectId}/incidents'] as unknown as {
      get?: OpenApiOperation;
      post?: OpenApiOperation;
    };
    expect(incidentPath.get?.responses?.['200']?.content?.['application/json']).toBeDefined();
    expect(incidentPath.post?.responses?.['201']?.content?.['application/json']).toBeDefined();
  });
  it('match deterministic openapi-typescript output from a live app document', async () => {
    // Break caught: a public route/schema changes while the client keeps a
    // stale generated type surface, allowing web or desktop to compile against
    // an API shape the live app no longer serves.
    const response = await documentedApp().inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(response.statusCode).toBe(200);

    const parsedDocument = response.json<{ paths: Record<string, Record<string, unknown>> }>();
    const document = `${JSON.stringify(parsedDocument, null, 2)}\n`;
    const generated = `${astToString(await openapiTypescript(document, { alphabetize: true })).trimEnd()}\n`;
    const operations = generatedOperations(parsedDocument.paths);

    if (process.env['UPDATE_OPENAPI_ARTIFACTS'] === '1') {
      await Promise.all([
        writeFile(OPENAPI_DOCUMENT, document),
        writeFile(GENERATED_TYPES, generated),
        writeFile(GENERATED_OPERATIONS, operations),
      ]);
    }

    await expect(readFile(OPENAPI_DOCUMENT, 'utf8')).resolves.toBe(document);
    await expect(readFile(GENERATED_TYPES, 'utf8')).resolves.toBe(generated);
    await expect(readFile(GENERATED_OPERATIONS, 'utf8')).resolves.toBe(operations);
  });

  it('documents structured run intent without exposing its durable fingerprint', async () => {
    // Break caught: the public create-run contract drops or widens the target/model
    // fields, makes optional input mandatory, omits persisted intent from the 201
    // response, or leaks the repository-only request fingerprint.
    const response = await documentedApp().inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    const { paths } = response.json<{ paths: Record<string, Record<string, OpenApiOperation>> }>();
    const operation = paths['/v1/projects/{projectId}/runs']?.['post'];
    const requestSchema = operation?.requestBody?.content?.['application/json']?.schema as
      | {
          properties?: Record<string, Record<string, unknown>>;
          required?: string[];
          anyOf?: Array<{
            properties?: Record<string, Record<string, unknown>>;
            required?: string[];
          }>;
        }
      | undefined;
    const responseSchema = operation?.responses?.['201']?.content?.['application/json'] as
      | {
          schema?: {
            properties?: {
              run?: {
                properties?: Record<string, Record<string, unknown>>;
                required?: string[];
              };
            };
          };
        }
      | undefined;
    const runSchema = responseSchema?.schema?.properties?.run;
    const requestVariants =
      requestSchema?.anyOf ?? (requestSchema === undefined ? [] : [requestSchema]);

    expect(requestVariants).toHaveLength(2);
    for (const variant of requestVariants) {
      expect(variant.properties?.['appType']).toMatchObject({
        enum: ['web', 'mobile'],
        type: 'string',
      });
      expect(variant.properties?.['model']).toMatchObject({
        maxLength: 160,
        minLength: 1,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$',
        type: 'string',
      });
      expect(variant.required).not.toContain('appType');
      expect(variant.required).not.toContain('model');
      expect(variant.properties).not.toHaveProperty('requestFingerprint');
    }
    const fixVariant = requestVariants.find((variant) => variant.required?.includes('fixRequest'));
    expect(fixVariant?.properties?.['mode']).toMatchObject({ enum: ['fix'] });
    expect(fixVariant?.properties?.['fixRequest']).toMatchObject({ type: 'object' });

    expect(runSchema?.properties?.['appType']).toMatchObject({
      enum: ['web', 'mobile'],
      type: 'string',
    });
    expect(runSchema?.properties?.['model']).toMatchObject({ nullable: true, type: 'string' });
    expect(runSchema?.required).toEqual(expect.arrayContaining(['appType', 'model']));
    expect(runSchema?.properties).not.toHaveProperty('requestFingerprint');
  });

  it('publishes the versioned notification preference API and generated operations', async () => {
    const response = await documentedApp().inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    const { paths } = response.json<{ paths: Record<string, Record<string, OpenApiOperation>> }>();

    expect(paths['/v1/notification-preferences']?.['get']?.responses?.['200']).toBeDefined();
    expect(paths['/v1/notification-preferences/{type}']?.['put']?.requestBody).toBeDefined();
  });

  it('publishes the versioned usage summary read model', async () => {
    const response = await documentedApp().inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    const { paths } = response.json<{ paths: Record<string, Record<string, OpenApiOperation>> }>();

    const operation = paths['/v1/usage/summary']?.['get'];
    expect(operation?.responses?.['200']).toBeDefined();
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: 'query', name: 'from', required: true }),
        expect.objectContaining({ in: 'query', name: 'to', required: true }),
      ]),
    );
  });

  it('publishes the reason-gated, support-session-bound admin API', async () => {
    const response = await documentedApp().inject({ method: 'GET', url: '/v1/openapi.json' });
    const { paths } = response.json<{ paths: Record<string, Record<string, OpenApiOperation>> }>();
    const supportSession = paths['/v1/admin/support-sessions']?.['post'];
    const overview =
      paths['/v1/admin/organizations/{organizationId}/overview']?.['get'];
    const terminateRun =
      paths['/v1/admin/organizations/{organizationId}/runs/{runId}/terminate']?.['post'];
    const terminateAll =
      paths['/v1/admin/organizations/{organizationId}/terminate-all']?.['post'];

    expect(supportSession?.requestBody?.required).toBe(true);
    expect(supportSession?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: 'header', name: 'idempotency-key', required: true }),
      ]),
    );
    expect(overview?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          in: 'header',
          name: 'x-zapp-support-session',
          required: true,
        }),
      ]),
    );
    expect(terminateRun?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: 'header', name: 'idempotency-key', required: true }),
        expect.objectContaining({
          in: 'header',
          name: 'x-zapp-support-session',
          required: true,
        }),
      ]),
    );
    expect(terminateAll?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: 'header', name: 'idempotency-key', required: true }),
        expect.objectContaining({
          in: 'header',
          name: 'x-zapp-support-session',
          required: true,
        }),
      ]),
    );

    type StartSupportSessionPost = NonNullable<
      GeneratedPaths['/v1/admin/support-sessions']['post']
    >;
    type SupportHeaders = NonNullable<StartSupportSessionPost['parameters']['header']>;
    const generatedHeaders: SupportHeaders = { 'idempotency-key': 'support-session-0001' };
    expect(generatedHeaders['idempotency-key']).toBe('support-session-0001');
  });
  it('projects validated model choices through the public membership schema', async () => {
    // Break caught: WEB-3 falls back to the Owner-only settings route when /v1/me
    // does not carry the model identifiers a Builder is permitted to select.
    const response = await documentedApp().inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    const { paths } = response.json<{ paths: Record<string, Record<string, OpenApiOperation>> }>();
    const meSchema = paths['/v1/me']?.['get']?.responses?.['200']?.content?.['application/json'] as
      | {
          schema?: {
            properties?: {
              memberships?: {
                items?: {
                  properties?: Record<string, Record<string, unknown>>;
                  required?: string[];
                };
              };
            };
          };
        }
      | undefined;
    const membership = meSchema?.schema?.properties?.memberships?.items;

    expect(membership?.properties?.['allowedModels']).toMatchObject({
      items: {
        maxLength: 160,
        minLength: 1,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$',
        type: 'string',
      },
      type: 'array',
    });
    expect(membership?.required).toContain('allowedModels');
  });

  it('documents optional strict auth bodies and actual no-content responses', async () => {
    // Break caught: nullish body schemas turn into required unknown request
    // bodies, while five handlers return 204 under a generated 200/null contract.
    const response = await documentedApp().inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    const { paths } = response.json<{ paths: Record<string, Record<string, OpenApiOperation>> }>();

    for (const path of ['/v1/auth/refresh', '/v1/auth/logout']) {
      const requestBody = paths[path]?.['post']?.requestBody;
      expect(requestBody?.required).toBe(false);
      const schema = requestBody?.content?.['application/json']?.schema;
      expect(JSON.stringify(schema)).toContain('refreshToken');
      expect(JSON.stringify(schema)).toContain('additionalProperties');
      expect(JSON.stringify(schema)).not.toContain('"not":{}');
    }

    for (const [path, method] of [
      ['/v1/auth/logout', 'post'],
      ['/v1/auth/device/approve', 'post'],
      ['/v1/auth/device/deny', 'post'],
      ['/v1/organizations/{orgId}/members/{userId}', 'delete'],
      ['/v1/projects/{projectId}/secrets/{secretId}', 'delete'],
    ] as const) {
      const responses = paths[path]?.[method]?.responses;
      expect(responses?.['204']).toBeDefined();
      expect(responses?.['200']).toBeUndefined();
    }
  });

  it('documents the settings PATCH idempotency key and non-empty body contract', async () => {
    // Break caught: a runtime-only body refinement or handler check leaves the
    // generated SDK accepting `{}` or a PATCH with no Idempotency-Key.
    const response = await documentedApp().inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    const { paths } = response.json<{ paths: Record<string, Record<string, unknown>> }>();
    const operation = paths['/v1/organizations/{orgId}/settings']?.['patch'] as
      | {
          parameters?: {
            in?: string;
            name?: string;
            required?: boolean;
            schema?: Record<string, unknown>;
          }[];
          requestBody?: {
            required?: boolean;
            content?: Record<string, { schema?: Record<string, unknown> }>;
          };
        }
      | undefined;

    expect(
      operation?.parameters?.find(
        (parameter) => parameter.in === 'header' && parameter.name === 'idempotency-key',
      ),
    ).toMatchObject({
      required: true,
      schema: { pattern: '^[A-Za-z0-9._:-]{8,255}$', type: 'string' },
    });
    expect(operation?.requestBody?.required).toBe(true);
    expect(operation?.requestBody?.content?.['application/json']?.schema).toMatchObject({
      anyOf: [
        { additionalProperties: false, required: ['builderCanDeploy'] },
        { additionalProperties: false, required: ['defaultModelPolicy'] },
      ],
    });
  });

  it('requires a validated GitHub import idempotency header in OpenAPI and generated types', async () => {
    // Break caught: runtime-only header extraction leaves the public SDK unable
    // to require the operation key that makes import acceptance replay-safe.
    type ImportPost = NonNullable<GeneratedPaths['/v1/projects/{projectId}/import/github']['post']>;
    type ImportHeaders = NonNullable<ImportPost['parameters']['header']>;
    const generatedHeaders: ImportHeaders = {
      'idempotency-key': 'github-import-operation-0001',
    };
    expect(generatedHeaders['idempotency-key']).toBe('github-import-operation-0001');

    const response = await documentedApp().inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    const { paths } = response.json<{ paths: Record<string, Record<string, OpenApiOperation>> }>();
    const operation = paths['/v1/projects/{projectId}/import/github']?.['post'];
    expect(
      operation?.parameters?.find(
        (parameter) => parameter.in === 'header' && parameter.name === 'idempotency-key',
      ),
    ).toMatchObject({
      required: true,
      schema: { pattern: '^[A-Za-z0-9._:-]{8,255}$', type: 'string' },
    });
  });

  it('requires a validated GitHub authorize idempotency header in OpenAPI and generated types', async () => {
    type AuthorizePost = NonNullable<
      GeneratedPaths['/v1/integrations/github/install/authorize']['post']
    >;
    type AuthorizeHeaders = NonNullable<AuthorizePost['parameters']['header']>;
    const generatedHeaders: AuthorizeHeaders = {
      'idempotency-key': 'github-authorize-operation-0001',
    };
    expect(generatedHeaders['idempotency-key']).toBe('github-authorize-operation-0001');

    const response = await documentedApp().inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    const { paths } = response.json<{ paths: Record<string, Record<string, OpenApiOperation>> }>();
    const operation = paths['/v1/integrations/github/install/authorize']?.['post'];
    expect(
      operation?.parameters?.find(
        (parameter) => parameter.in === 'header' && parameter.name === 'idempotency-key',
      ),
    ).toMatchObject({
      required: true,
      schema: { pattern: '^[A-Za-z0-9._:-]{8,255}$', type: 'string' },
    });
  });

  it('publishes semantic dashboard identifiers, explicit preview state, and resolved branch SHAs', async () => {
    const response = await documentedApp().inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    const { paths } = response.json<{ paths: Record<string, Record<string, OpenApiOperation>> }>();
    const summarySchema = paths['/v1/projects/summaries']?.['get']?.responses?.['200']?.content?.[
      'application/json'
    ] as
      | {
          schema?: {
            properties?: {
              summaries?: {
                items?: { properties?: Record<string, Record<string, unknown>> };
              };
            };
          };
        }
      | undefined;
    const summary = summarySchema?.schema?.properties?.summaries?.items?.properties;
    expect(summary?.['projectId']).toMatchObject({
      pattern: '^proj_[0-9A-HJKMNP-TV-Z]{26}$',
      type: 'string',
    });
    expect(summary?.['preview']).toMatchObject({ required: ['status', 'occurredAt'] });
    expect(summary?.['preview']).not.toHaveProperty('nullable');
    const production = summary?.['production'] as
      { properties?: Record<string, unknown> } | undefined;
    expect(production?.properties?.['releaseId']).toMatchObject({
      pattern: '^rel_[0-9A-HJKMNP-TV-Z]{26}$',
      type: 'string',
    });
    const deployReadiness = summary?.['deployReadiness'] as
      { properties?: Record<string, unknown> } | undefined;
    expect(deployReadiness?.properties?.['releaseId']).toMatchObject({
      pattern: '^rel_[0-9A-HJKMNP-TV-Z]{26}$',
      type: 'string',
    });

    const branchSchema = paths['/v1/integrations/github/repositories/{repositoryId}/branches']?.[
      'get'
    ]?.responses?.['200']?.content?.['application/json'] as
      | {
          schema?: {
            properties?: {
              items?: {
                items?: { properties?: Record<string, Record<string, unknown>> };
              };
            };
          };
        }
      | undefined;
    expect(
      branchSchema?.schema?.properties?.items?.items?.properties?.['headCommitSha'],
    ).toMatchObject({ pattern: '^[0-9a-f]{40}$', type: 'string' });
  });

  it('documents every formerly schema-less redirect with its live status and location header', async () => {
    // Break caught: the fallback invents a JSON 200/null response for login and
    // callback even though both live handlers return an empty 302 with Location.
    const built = documentedHarness();
    const documentResponse = await built.app.inject({ method: 'GET', url: '/v1/openapi.json' });
    const { paths } = documentResponse.json<{
      paths: Record<string, Record<string, OpenApiOperation>>;
    }>();

    const login = await built.app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(login.headers.location as string).searchParams.get('state') ?? '';
    const identity: AuthIdentity = {
      externalId: 'openapi-callback-user',
      email: 'openapi-callback@zapp.test',
      displayName: 'OpenAPI Callback',
    };
    built.port.issueCode('openapi-code', identity);
    const callback = await built.app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=openapi-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieJar(cookiesOf(login.headers['set-cookie'])) },
    });

    for (const [path, actual] of [
      ['/v1/auth/login', login],
      ['/v1/auth/callback', callback],
    ] as const) {
      expect(actual.statusCode).toBe(302);
      expect(actual.body).toBe('');
      expect(actual.headers.location).toEqual(expect.stringMatching(/^https:\/\//));
      const responses = paths[path]?.['get']?.responses;
      expect(responses?.['302']).toMatchObject({
        headers: {
          Location: {
            required: true,
            schema: { type: 'string' },
          },
        },
      });
      expect(responses?.['302']?.content).toBeUndefined();
      expect(responses?.['200']).toBeUndefined();
    }
  });

  it('documents the complete public builder-preview bridge', async () => {
    const response = await documentedApp().inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    const { paths } = response.json<{ paths: Record<string, Record<string, OpenApiOperation>> }>();
    const workspace = '/v1/workspaces/{workspaceId}';

    expect(
      paths[`${workspace}/dev-server/logs`]?.['get']?.responses?.['200']?.content,
    ).toHaveProperty('application/json');
    expect(
      paths[`${workspace}/dev-server/restart`]?.['post']?.responses?.['200']?.content,
    ).toHaveProperty('application/json');
    expect(
      paths[`${workspace}/preview/events`]?.['get']?.responses?.['200']?.content,
    ).toHaveProperty('text/event-stream');
    expect(paths[`${workspace}/preview/screenshot`]?.['post']?.responses?.['200']?.content).toEqual(
      {
        'image/png': { schema: { format: 'binary', type: 'string' } },
      },
    );
    expect(paths[`${workspace}/preview/screenshot`]?.['post']?.responses?.['501']).toBeDefined();
    expect(
      paths[`${workspace}/preview/screenshot`]?.['post']?.responses?.['501']?.content,
    ).toBeUndefined();
    expect(paths[`${workspace}/preview/screenshot`]?.['post']?.responses?.['503']).toBeDefined();
    expect(
      paths[`${workspace}/preview/screenshot`]?.['post']?.responses?.['503']?.content,
    ).toBeUndefined();

    for (const path of [`${workspace}/dev-server/restart`, `${workspace}/preview/screenshot`]) {
      expect(
        paths[path]?.['post']?.parameters?.find(
          (parameter) => parameter.in === 'header' && parameter.name === 'idempotency-key',
        ),
      ).toMatchObject({ required: true });
    }
  });

  it('preserves security alternatives and response obligations in runtime metadata', () => {
    // Break caught: reducing security to public/optional/required blocks valid
    // cookie authentication and sends bearer tokens to operations that forbid it.
    const operations = PUBLIC_API_OPERATIONS as unknown as Record<string, Record<string, unknown>>;

    expect(operations['/v1/me']?.['get']).toEqual({
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      successResponses: {
        '200': {
          body: 'required',
          mediaTypes: ['application/json'],
          requiredHeaders: [],
        },
      },
    });
    expect(operations['/v1/auth/refresh']?.['post']).toMatchObject({
      security: [{}, { refreshCookie: [], csrfToken: [] }],
    });
    expect(operations['/v1/auth/logout']?.['post']).toMatchObject({
      security: [
        {},
        { bearerAuth: [] },
        { sessionCookie: [], csrfToken: [] },
        { refreshCookie: [], csrfToken: [] },
      ],
    });
    expect(operations['/v1/auth/login']?.['get']).toEqual({
      security: [],
      successResponses: {
        '302': {
          body: 'forbidden',
          mediaTypes: [],
          requiredHeaders: ['Location'],
        },
      },
    });
  });
});

function generatedOperations(paths: Record<string, Record<string, unknown>>): string {
  const operations = Object.fromEntries(
    Object.keys(paths)
      .sort()
      .map((path) => [
        path,
        Object.fromEntries(
          HTTP_METHODS.flatMap((method) => {
            const operation = paths[path]?.[method] as OpenApiOperation | undefined;
            if (operation === undefined) return [];
            const successResponses = Object.fromEntries(
              Object.entries(operation.responses ?? {})
                .filter(([status]) => /^[23]\d\d$/.test(status))
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([status, response]) => {
                  const mediaTypes = Object.keys(response.content ?? {}).sort();
                  const requiredHeaders = Object.entries(response.headers ?? {})
                    .filter(([, header]) => header.required === true)
                    .map(([name]) => name)
                    .sort();
                  return [
                    status,
                    {
                      body: mediaTypes.length === 0 ? 'forbidden' : 'required',
                      mediaTypes,
                      requiredHeaders,
                    },
                  ];
                }),
            );
            return [
              [
                method,
                {
                  security: operation.security ?? [],
                  successResponses,
                },
              ],
            ];
          }),
        ),
      ]),
  );
  return `/** Generated from the live public OpenAPI document. Do not edit. */\nexport const PUBLIC_API_OPERATIONS = ${JSON.stringify(operations, null, 2)} as const;\n`;
}
