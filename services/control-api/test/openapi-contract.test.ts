import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { astToString, default as openapiTypescript } from 'openapi-typescript';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppInstance } from '../src/app.js';
import type { AuthIdentity } from '../src/auth/port.js';
import { PUBLIC_API_OPERATIONS } from '../../../packages/api-client/src/generated-operations.js';
import { buildHarness, cookieJar, cookiesOf, type Harness } from './support/harness.js';

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
    tenantDb: () => {
      throw new Error('OpenAPI generation must not access the tenant database.');
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

    expect(requestSchema?.properties?.['appType']).toMatchObject({
      enum: ['web', 'mobile'],
      type: 'string',
    });
    expect(requestSchema?.properties?.['model']).toMatchObject({
      maxLength: 160,
      minLength: 1,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$',
      type: 'string',
    });
    expect(requestSchema?.required).not.toContain('appType');
    expect(requestSchema?.required).not.toContain('model');
    expect(requestSchema?.properties).not.toHaveProperty('requestFingerprint');

    expect(runSchema?.properties?.['appType']).toMatchObject({
      enum: ['web', 'mobile'],
      type: 'string',
    });
    expect(runSchema?.properties?.['model']).toMatchObject({ nullable: true, type: 'string' });
    expect(runSchema?.required).toEqual(expect.arrayContaining(['appType', 'model']));
    expect(runSchema?.properties).not.toHaveProperty('requestFingerprint');
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
