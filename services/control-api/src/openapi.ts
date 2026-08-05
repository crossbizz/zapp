import swagger from '@fastify/swagger';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

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
    },
    transform: publicRouteTransform,
  });

  app.after((error) => {
    if (error) throw error;
    app.get('/v1/openapi.json', { schema: { hide: true } }, () => app.swagger());
  });
}

/** The generated SDK is the client boundary, so internal service routes stay out. */
function publicRouteTransform(input: Parameters<typeof jsonSchemaTransform>[0]) {
  if (!input.url.startsWith('/v1/')) return { schema: { hide: true }, url: input.url };
  return jsonSchemaTransform(input);
}
