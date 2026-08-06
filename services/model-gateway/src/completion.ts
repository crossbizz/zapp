import type { CompletionBackend } from './app.js';
import type { ModelsConfig, ProviderId } from './models.js';
import type { ProviderAdapter } from './providers/types.js';

export function createConfiguredCompletion(options: {
  readonly models: ModelsConfig;
  readonly providers: Partial<Record<ProviderId, ProviderAdapter>>;
}): CompletionBackend {
  return {
    stream: (request, signal) => {
      const reference = options.models.roles[request.agentRole].primary;
      const separator = reference.indexOf('/');
      const providerId = reference.slice(0, separator) as ProviderId;
      const modelId = reference.slice(separator + 1);
      const provider = options.providers[providerId];
      if (provider === undefined) {
        throw new Error(`model provider ${providerId} is disabled`);
      }
      return provider.stream({ modelId, request, signal });
    },
  };
}
