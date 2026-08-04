import { ApiErrorSchema } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildApp, type AppInstance } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { ApiError } from '../src/errors.js';
import { logSerializers } from '../src/logging.js';

/**
 * Every test builds its own app with logging off, and registers whatever routes it
 * needs *after* `buildApp` returns — routes added before `ready()` inherit the root
 * error handler and compilers, so the fixtures exercise the real pipeline without
 * the service shipping a single route beyond `/healthz`.
 */
const apps: AppInstance[] = [];

function testApp(register?: (app: AppInstance) => void): AppInstance {
  const app = buildApp({ logger: false });
  register?.(app);
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /healthz', () => {
  it('answers 200 with { status: "ok" } and no envelope', async () => {
    const response = await testApp().inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('request id', () => {
  it('stamps x-request-id on success, 404 and 500 responses alike', async () => {
    const app = testApp((instance) => {
      instance.get('/v1/kaboom', () => {
        throw new Error('handler exploded');
      });
    });

    for (const url of ['/healthz', '/v1/nope', '/v1/kaboom']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.headers['x-request-id'], url).toEqual(expect.stringMatching(/\S/));
    }
  });

  it('round-trips an inbound x-request-id into the header and the error envelope', async () => {
    const response = await testApp().inject({
      method: 'GET',
      url: '/v1/nope',
      headers: { 'x-request-id': 'trace-from-the-edge' },
    });

    expect(response.headers['x-request-id']).toBe('trace-from-the-edge');
    expect(ApiErrorSchema.parse(response.json()).error.requestId).toBe('trace-from-the-edge');
  });

  it('generates a fresh id when the inbound header is blank, oversized or unsafe', async () => {
    const app = testApp();
    const rejected = ['   ', 'x'.repeat(129), 'has spaces', 'inject\nheader'];

    for (const candidate of rejected) {
      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-request-id': candidate },
      });

      expect(response.headers['x-request-id'], candidate).not.toBe(candidate);
      expect(response.headers['x-request-id'], candidate).toEqual(
        expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      );
    }
  });
});

describe('error envelope', () => {
  it('answers an unknown route with a 404 route_not_found envelope', async () => {
    const response = await testApp().inject({ method: 'GET', url: '/v1/does-not-exist' });

    expect(response.statusCode).toBe(404);
    const body = ApiErrorSchema.parse(response.json());
    expect(body.error.code).toBe('route_not_found');
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('maps a thrown ApiError to its own status, code and details', async () => {
    const app = testApp((instance) => {
      instance.get('/v1/teapot', () => {
        throw new ApiError('teapot_error', 418, 'I cannot brew coffee.', { brews: 'tea' });
      });
    });

    const response = await app.inject({ method: 'GET', url: '/v1/teapot' });

    expect(response.statusCode).toBe(418);
    expect(ApiErrorSchema.parse(response.json()).error).toEqual({
      code: 'teapot_error',
      message: 'I cannot brew coffee.',
      requestId: response.headers['x-request-id'],
      details: { brews: 'tea' },
    });
  });

  it('reduces a body Fastify could not parse to a 400 bad_request, in our words', async () => {
    // The fourth branch of the handler: a 4xx raised by the framework itself,
    // whose wording ("Unexpected token } in JSON at position 14") is neither
    // ours nor tenant-safe, so only the status survives.
    const app = testApp((instance) => {
      instance.post('/v1/echo', { schema: { body: z.object({ name: z.string() }) } }, () => ({}));
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"name": "acme-secret-customer",}',
    });

    expect(response.statusCode).toBe(400);
    const body = ApiErrorSchema.parse(response.json());
    expect(body.error.code).toBe('bad_request');
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
    expect(response.body).not.toContain('acme-secret-customer');
  });

  it('keeps the envelope for an ApiError thrown from a hook, not just a handler', async () => {
    // Authentication, CSRF and rate limiting all reject in `preHandler` rather
    // than in the route body (CP-2 onward), so the envelope has to survive a
    // throw that happens before any handler runs.
    const app = testApp((instance) => {
      instance.get(
        '/v1/guarded',
        {
          preHandler: () => {
            throw new ApiError('unauthenticated', 401, 'Authentication is required.');
          },
        },
        () => ({ reached: true }),
      );
    });

    const response = await app.inject({ method: 'GET', url: '/v1/guarded' });

    expect(response.statusCode).toBe(401);
    expect(ApiErrorSchema.parse(response.json()).error).toEqual({
      code: 'unauthenticated',
      message: 'Authentication is required.',
      requestId: response.headers['x-request-id'],
    });
  });

  it('survives a route whose own response schema has no room for the envelope', async () => {
    // The route declares what a 404 looks like *for it*; the error envelope is
    // not that shape, and compiling it against that schema would strip the body
    // down to `{}`. `errorHandler` serializes errors itself for exactly this.
    const app = testApp((instance) => {
      instance.get(
        '/v1/projects/:id',
        { schema: { response: { 404: z.object({ reason: z.literal('gone') }) } } },
        () => {
          throw new ApiError('project_not_found', 404, 'That project does not exist.');
        },
      );
    });

    const response = await app.inject({ method: 'GET', url: '/v1/projects/proj_1' });

    expect(response.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(response.json()).error).toEqual({
      code: 'project_not_found',
      message: 'That project does not exist.',
      requestId: response.headers['x-request-id'],
    });
  });

  it('reduces an unexpected throw to a generic 500 with no internals in the body', async () => {
    const app = testApp((instance) => {
      instance.get('/v1/kaboom', () => {
        throw new Error('ECONNREFUSED postgres://user:hunter2@10.0.0.1:5432');
      });
    });

    const response = await app.inject({ method: 'GET', url: '/v1/kaboom' });

    expect(response.statusCode).toBe(500);
    const body = ApiErrorSchema.parse(response.json());
    expect(body.error.code).toBe('internal_error');
    expect(body.error.details).toBeUndefined();
    for (const leak of ['ECONNREFUSED', 'hunter2', '10.0.0.1', 'at ', 'stack', '.ts:']) {
      expect(response.body, leak).not.toContain(leak);
    }
  });

  it('rejects invalid input with 400 validation_failed carrying paths, never values', async () => {
    const app = testApp((instance) => {
      instance.post(
        '/v1/echo',
        { schema: { body: z.object({ email: z.string().email(), age: z.number() }) } },
        (request) => request.body,
      );
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/echo',
      payload: { email: 'acme-secret-customer', age: 'not-a-number' },
    });

    expect(response.statusCode).toBe(400);
    const body = ApiErrorSchema.parse(response.json());
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details).toEqual({
      issues: [
        { path: 'body.email', code: 'invalid_string' },
        { path: 'body.age', code: 'invalid_type' },
      ],
    });
    for (const leak of ['acme-secret-customer', 'not-a-number']) {
      expect(response.body, leak).not.toContain(leak);
    }
  });
});

describe('environment', () => {
  it('boots on port 4000 in production mode when nothing is set', () => {
    // `production` is the safe default: it is the position in which every switch
    // reading NODE_ENV — starting with pretty logging, whose formatter is only a
    // devDependency — stays off.
    expect(loadEnv({})).toEqual({
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: 4000,
      LOG_LEVEL: 'info',
    });
  });

  it('coerces PORT and rejects a value outside the port range by name only', () => {
    expect(loadEnv({ PORT: '8080' }).PORT).toBe(8080);
    expect(() => loadEnv({ PORT: '70000' })).toThrowError(new Error('Invalid environment: PORT'));
  });
});

describe('log serializers', () => {
  it('reduces a request to request id, method and url — never headers or body', () => {
    const serialized = logSerializers.req({
      id: 'req-1',
      method: 'POST',
      url: '/v1/secrets',
      headers: { authorization: 'Bearer super-secret', cookie: 'session=abc' },
      body: { value: 'sk-live-must-never-be-logged' },
    } as never);

    expect(serialized).toEqual({ requestId: 'req-1', method: 'POST', url: '/v1/secrets' });
    for (const leak of ['Bearer', 'session=', 'sk-live']) {
      expect(JSON.stringify(serialized), leak).not.toContain(leak);
    }
  });

  it('keeps an invite token out of the request line', () => {
    // The one route whose *path* carries a credential (plan 02 CP-3). Logging
    // it verbatim would write a seven-day bearer token into this service's log
    // and into every proxy in front of it.
    const token = 'a'.repeat(64);
    const serialized = logSerializers.req({
      id: 'req-2',
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
    });

    expect(serialized.url).toBe('/v1/invites/:token/accept');
    expect(JSON.stringify(serialized)).not.toContain(token);
  });

  it('leaves a url with nothing secret in it alone', () => {
    expect(
      logSerializers.req({ id: 'req-3', method: 'GET', url: '/v1/organizations?x=1' }).url,
    ).toBe('/v1/organizations?x=1');
  });

  it('reduces a reply to its status code', () => {
    expect(
      logSerializers.res({ statusCode: 204, headers: { 'set-cookie': 'x' } } as never),
    ).toEqual({ statusCode: 204 });
  });
});
