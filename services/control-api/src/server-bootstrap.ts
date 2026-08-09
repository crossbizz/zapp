import type { EventPublisherLifecycle } from './events/lifecycle.js';
import type { UsageOutboxPublisherLifecycle } from './usage/outbox.js';

interface ServerHookApp {
  addHook(name: 'onClose', hook: () => Promise<void>): void;
}

export async function bootstrapControlApiServer(input: {
  readonly app: ServerHookApp;
  readonly eventPublisherLifecycle: EventPublisherLifecycle;
  readonly usageOutboxLifecycle?: UsageOutboxPublisherLifecycle;
}): Promise<void> {
  input.app.addHook('onClose', async () => {
    await input.usageOutboxLifecycle?.close();
    await input.eventPublisherLifecycle.close();
  });
  await input.usageOutboxLifecycle?.start();
  await input.eventPublisherLifecycle.start();
}
