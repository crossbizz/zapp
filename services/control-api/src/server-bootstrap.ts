import type { EventPublisherLifecycle } from './events/lifecycle.js';
import type { UsageOutboxPublisherLifecycle } from './usage/outbox.js';
import type { GitHubWebhookPublisherLifecycle } from './integrations/github/queue.js';

interface ServerHookApp {
  addHook(name: 'onClose', hook: () => Promise<void>): void;
}

export async function bootstrapControlApiServer(input: {
  readonly app: ServerHookApp;
  readonly eventPublisherLifecycle: EventPublisherLifecycle;
  readonly usageOutboxLifecycle?: UsageOutboxPublisherLifecycle;
  readonly githubWebhookLifecycle?: GitHubWebhookPublisherLifecycle;
}): Promise<void> {
  input.app.addHook('onClose', async () => {
    await input.githubWebhookLifecycle?.close();
    await input.usageOutboxLifecycle?.close();
    await input.eventPublisherLifecycle.close();
  });
  await input.githubWebhookLifecycle?.start();
  await input.usageOutboxLifecycle?.start();
  await input.eventPublisherLifecycle.start();
}
