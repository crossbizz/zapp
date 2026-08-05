import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AppInstance } from '../src/app.js';
import { buildHarness } from './support/harness.js';

const apps: AppInstance[] = [];

function documentedApp(): AppInstance {
  const built = buildHarness({
    // Route registration is declarative; this sentinel makes an accidental
    // database access during document creation loud without supplying a fake
    // data surface the routes could accidentally use.
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

describe('GET /v1/openapi.json', () => {
  it('publishes OpenAPI 3 schemas for public auth, project, run, and SSE routes', async () => {
    // Break caught: removing the public document route or registering OpenAPI
    // after the Zod routes would leave clients without typed API contracts.
    const response = await documentedApp().inject({ method: 'GET', url: '/v1/openapi.json' });

    expect(response.statusCode).toBe(200);
    const document: {
      openapi: string;
      paths: Record<
        string,
        {
          get?: { parameters?: Array<{ in: string; name: string }>; responses?: Record<string, unknown> };
          post?: {
            requestBody?: { content?: Record<string, unknown> };
            responses?: Record<string, unknown>;
          };
        }
      >;
    } = response.json();

    expect(document.openapi).toMatch(/^3\.0\./);
    expect(document.paths['/v1/auth/login']?.get?.responses).toHaveProperty('200');
    expect(document.paths['/v1/projects']?.post?.requestBody?.content).toHaveProperty(
      'application/json',
    );
    expect(document.paths['/v1/runs/{runId}']?.get?.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ in: 'path', name: 'runId' })]),
    );
    expect(document.paths['/v1/runs/{runId}/events']?.get?.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ in: 'query', name: 'after' })]),
    );
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(['/v1/projects']));
    expect(Object.keys(document.paths).every((path) => path.startsWith('/v1/'))).toBe(true);
  });

  it('refuses an unrepresentable route schema instead of silently omitting it', () => {
    // Break caught: a route reaches production while its response cannot be
    // serialized or represented in the generated API contract.
    const app = documentedApp();
    expect(() => {
      app.get(
        '/v1/unrepresentable',
        { schema: { body: z.function().args().returns(z.string()) } },
        () => ({ ok: true }),
      );
    }).toThrow(/not supported/i);
  });
});
