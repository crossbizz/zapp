import type { CompletionBackend } from './app.js';
import type { ModelsConfig, ProviderId } from './models.js';
import type { ProviderAdapter } from './providers/types.js';
import { createRoutingCompletion, type RoutingDependencies } from './routing.js';

export function createConfiguredCompletion(options: {
  readonly models: ModelsConfig;
  readonly providers: Partial<Record<ProviderId, ProviderAdapter>>;
  readonly routing?: RoutingDependencies;
}): CompletionBackend {
  return createRoutingCompletion(options);
}
