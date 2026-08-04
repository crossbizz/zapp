import type { EventPublisherLifecycle } from './events/lifecycle.js';

interface ServerHookApp {
  addHook(name: 'onClose', hook: () => Promise<void>): void;
}

export async function bootstrapControlApiServer(input: {
  readonly app: ServerHookApp;
  readonly eventPublisherLifecycle: EventPublisherLifecycle;
}): Promise<void> {
  input.app.addHook('onClose', async () => {
    await input.eventPublisherLifecycle.close();
  });
  await input.eventPublisherLifecycle.start();
}
