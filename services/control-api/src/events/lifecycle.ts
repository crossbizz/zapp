import type { EventPublisher } from './publisher.js';

interface AsyncCloseable {
  close(): Promise<void>;
}

export interface EventPublisherLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createEventPublisherLifecycle(input: {
  readonly publisher: EventPublisher;
  readonly listen: () => Promise<unknown>;
  readonly database: AsyncCloseable;
  readonly redis: AsyncCloseable;
}): EventPublisherLifecycle {
  return {
    async start() {
      input.publisher.start();
      await input.publisher.ready();
      await input.listen();
    },
    async close() {
      await input.publisher.close();
      await input.database.close();
      await input.redis.close();
    },
  };
}
