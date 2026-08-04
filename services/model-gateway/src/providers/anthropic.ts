import { createAnthropic } from '@ai-sdk/anthropic';
import { streamText } from 'ai';

import { createAiSdkAdapter } from './adapter.js';
import type { AiSdkDependencies, ProviderAdapter } from './types.js';

const productionDependencies: AiSdkDependencies = {
  createProvider(settings) {
    return createAnthropic({
      ...(settings.apiKey === undefined ? {} : { apiKey: settings.apiKey }),
      ...(settings.baseURL === undefined ? {} : { baseURL: settings.baseURL }),
    });
  },
  streamText(options) {
    return streamText(options);
  },
};

export function createAnthropicAdapter(options: {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly dependencies?: AiSdkDependencies;
}): ProviderAdapter {
  return createAiSdkAdapter({
    provider: 'anthropic',
    providerSettings: {
      apiKey: options.apiKey,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    },
    dependencies: options.dependencies ?? productionDependencies,
  });
}
