import { describe, expect, it } from 'vitest';

import { bootstrapControlApiServer } from '../src/server-bootstrap.js';

describe('control-api production bootstrap', () => {
  it('starts the event publisher lifecycle', async () => {
    // Break caught: production creates the publisher but never starts it before
    // the server entrypoint finishes booting.
    let started = false;

    await bootstrapControlApiServer({
      app: { addHook() {} },
      eventPublisherLifecycle: {
        start() {
          started = true;
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      },
    });

    expect(started).toBe(true);
  });

  it('registers event publisher lifecycle close on the production app', async () => {
    // Break caught: app shutdown closes Fastify without stopping the publisher
    // before its database and Redis handles.
    let onClose: (() => Promise<void>) | undefined;
    let closed = false;

    await bootstrapControlApiServer({
      app: {
        addHook(_name, hook) {
          onClose = hook;
        },
      },
      eventPublisherLifecycle: {
        start: () => Promise.resolve(),
        close() {
          closed = true;
          return Promise.resolve();
        },
      },
    });

    expect(onClose).toBeTypeOf('function');
    await onClose?.();
    expect(closed).toBe(true);
  });
});
