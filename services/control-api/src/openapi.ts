import swagger from '@fastify/swagger';
import { AgentEventSchema, ApiErrorSchema } from '@zapp/contracts';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  CSRF_HEADER,
  REFRESH_COOKIE,
  SESSION_COOKIE,
} from './auth/cookies.js';
import type { AppInstance } from './app.js';

/**
 * Registers the public OpenAPI document before API routes enroll themselves.
 *
 * `@fastify/swagger` records route schemas through its `onRoute` hook, so this
 * must run before any route-enrolling `after` callbacks. The document endpoint
 * itself is hidden to avoid documenting an endpoint whose payload is the
 * document currently being built.
 */
export function registerOpenApi(app: AppInstance): void {
  void app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'zapp.build Control Plane API',
        version: 'v1',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          sessionCookie: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
          refreshCookie: { type: 'apiKey', in: 'cookie', name: REFRESH_COOKIE },
          csrfToken: { type: 'apiKey', in: 'header', name: CSRF_HEADER },
        },
      },
    },
    transform: (input) => publicRouteTransform(app, input),
  });

  app.after((error) => {
    if (error) throw error;
    app.get('/v1/openapi.json', { schema: { hide: true } }, () => app.swagger());
  });
}

/** The generated SDK is the client boundary, so internal service routes stay out. */
function publicRouteTransform(
  app: AppInstance,
  input: Parameters<typeof jsonSchemaTransform>[0] & {
    route: { readonly preHandler?: unknown; readonly method: string | readonly string[] };
  },
) {
  if (!input.url.startsWith('/v1/')) return { schema: { hide: true }, url: input.url };

  const response = {
    ...(isEventStreamRoute(input.url) ? { 200: AgentEventSchema } : {}),
    ...responseSchemas(input.schema.response),
    ...(input.schema.response === undefined && !isEventStreamRoute(input.url)
      ? { 200: z.null() }
      : {}),
    '4XX': ApiErrorSchema,
    '5XX': ApiErrorSchema,
  };
  const transformed = jsonSchemaTransform({
    schema: {
      ...input.schema,
      response,
    },
    url: input.url,
  });
  const security = routeSecurity(app, input);
  const transformedSchema = isEventStreamRoute(input.url)
    ? withEventStreamContent(transformed.schema)
    : transformed.schema;

  return {
    ...transformed,
    schema: security === undefined ? transformedSchema : { ...transformedSchema, security },
  };
}

function responseSchemas(response: unknown): Record<string, unknown> {
  return response !== null && typeof response === 'object'
    ? (response as Record<string, unknown>)
    : {};
}

function routeSecurity(
  app: AppInstance,
  input: {
    readonly url: string;
    readonly route: { readonly preHandler?: unknown; readonly method: string | readonly string[] };
  },
): Array<Record<string, never[]>> | undefined {
  const requiresSession = hasPreHandler(input.route.preHandler, app.requireSession);
  const requiresCsrf = hasPreHandler(input.route.preHandler, app.requireCsrf);
  if (requiresSession) {
    return requiresCsrf
      ? [{ bearerAuth: [] }, { sessionCookie: [], csrfToken: [] }]
      : [{ bearerAuth: [] }, { sessionCookie: [] }];
  }

  if (input.url === '/v1/auth/refresh') {
    return [{}, { refreshCookie: [], csrfToken: [] }];
  }
  if (input.url === '/v1/auth/logout') {
    return [
      {},
      { bearerAuth: [] },
      { sessionCookie: [], csrfToken: [] },
      { refreshCookie: [], csrfToken: [] },
    ];
  }
  return undefined;
}

function hasPreHandler(value: unknown, expected: unknown): boolean {
  const handlers = Array.isArray(value) ? value : [value];
  return handlers.includes(expected);
}

function isEventStreamRoute(url: string): boolean {
  return url === '/v1/runs/:runId/events';
}

function withEventStreamContent(schema: object): object {
  const response = responseSchemas((schema as { response?: unknown }).response);
  const success = response['200'];
  return {
    ...schema,
    response: {
      ...response,
      200: {
        content: {
          'text/event-stream': { schema: success },
        },
      },
    },
  };
}
