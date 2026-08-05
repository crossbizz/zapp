import { describe, expect, it } from 'vitest';

import { createEventPublisherLifecycle } from '../src/events/lifecycle.js';

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('production event publisher lifecycle', () => {
  it('starts the publisher and waits for readiness before listening', async () => {
    // Break caught: the HTTP server accepts traffic before its PostgreSQL
    // LISTEN subscription is ready.
    const ready = deferred();
    const order: string[] = [];
    const lifecycle = createEventPublisherLifecycle({
      publisher: {
        start() {
          order.push('publisher:start');
        },
        ready() {
          order.push('publisher:ready');
          return ready.promise;
        },
        close: () => Promise.resolve(),
      },
      listen() {
        order.push('app:listen');
        return Promise.resolve();
      },
      database: { close: () => Promise.resolve() },
      redis: { close: () => Promise.resolve() },
    });

    const starting = lifecycle.start();
    expect(order).toEqual(['publisher:start', 'publisher:ready']);

    ready.resolve();
    await starting;
    expect(order).toEqual(['publisher:start', 'publisher:ready', 'app:listen']);
  });

  it('closes the publisher before database and Redis resources', async () => {
    // Break caught: shared clients close while the publisher can still query
    // PostgreSQL or publish a final queued notification.
    const order: string[] = [];
    const lifecycle = createEventPublisherLifecycle({
      publisher: {
        start() {},
        ready: () => Promise.resolve(),
        close() {
          order.push('publisher:close');
          return Promise.resolve();
        },
      },
      listen: () => Promise.resolve(),
      database: {
        close() {
          order.push('database:close');
          return Promise.resolve();
        },
      },
      redis: {
        close() {
          order.push('redis:close');
          return Promise.resolve();
        },
      },
    });

    await lifecycle.close();

    expect(order).toEqual(['publisher:close', 'database:close', 'redis:close']);
  });
});
