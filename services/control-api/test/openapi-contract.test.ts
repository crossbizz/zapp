import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { astToString, default as openapiTypescript } from 'openapi-typescript';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppInstance } from '../src/app.js';
import { buildHarness } from './support/harness.js';

const GENERATED_TYPES = resolve(import.meta.dirname, '../../../packages/api-client/src/generated.ts');
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
  responses?: Record<string, { content?: Record<string, unknown> }>;
  security?: readonly Record<string, readonly string[]>[];
}

function documentedApp(): AppInstance {
  const built = buildHarness({
    tenantDb: (() => {
      throw new Error('OpenAPI generation must not access the tenant database.');
    }),
  });
  apps.push(built.app);
  return built.app;
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
            const successMediaTypes = Object.entries(operation.responses ?? {})
              .filter(([status]) => /^2\d\d$/.test(status))
              .flatMap(([, response]) => Object.keys(response.content ?? {}))
              .sort();
            const requiresAuth = operation.security !== undefined
              && operation.security.length > 0
              && operation.security.every((requirement) => Object.keys(requirement).length > 0);
            return [[method, { requiresAuth, successMediaTypes }]];
          }),
        ),
      ]),
  );
  return `/** Generated from the live public OpenAPI document. Do not edit. */\nexport const PUBLIC_API_OPERATIONS = ${JSON.stringify(operations, null, 2)} as const;\n`;
}
