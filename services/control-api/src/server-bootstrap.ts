import type { EventPublisherLifecycle } from './events/lifecycle.js';
import type { UsageOutboxPublisherLifecycle } from './usage/outbox.js';
import type { GitHubWebhookPublisherLifecycle } from './integrations/github/queue.js';
import type { GitHubImportLifecycle } from './integrations/github/import-queue.js';
import type { NotificationWorkerLifecycle } from './notifications/service.js';

interface ServerHookApp {
  addHook(name: 'onClose', hook: () => Promise<void>): void;
}

export async function bootstrapControlApiServer(input: {
  readonly app: ServerHookApp;
  readonly eventPublisherLifecycle: EventPublisherLifecycle;
  readonly usageOutboxLifecycle?: UsageOutboxPublisherLifecycle;
  readonly githubWebhookLifecycle?: GitHubWebhookPublisherLifecycle;
  readonly githubImportLifecycle?: GitHubImportLifecycle;
  readonly notificationLifecycle?: NotificationWorkerLifecycle;
}): Promise<void> {
  input.app.addHook('onClose', async () => {
    await input.githubImportLifecycle?.close();
    await input.notificationLifecycle?.close();
    await input.githubWebhookLifecycle?.close();
    await input.usageOutboxLifecycle?.close();
    await input.eventPublisherLifecycle.close();
  });
  await input.githubImportLifecycle?.start();
  await input.notificationLifecycle?.start();
  await input.githubWebhookLifecycle?.start();
  await input.usageOutboxLifecycle?.start();
  await input.eventPublisherLifecycle.start();
}
