import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';

import { createAiSdkAdapter } from './adapter.js';
import type { AiSdkDependencies, ProviderAdapter } from './types.js';

const productionDependencies: AiSdkDependencies = {
  createProvider(settings) {
    if (settings.baseURL === undefined || settings.name === undefined) {
      throw new Error('OpenAI-compatible provider needs its configured base URL and name');
    }
    return createOpenAICompatible({
      baseURL: settings.baseURL,
      name: settings.name,
      ...(settings.apiKey === undefined ? {} : { apiKey: settings.apiKey }),
      ...(settings.includeUsage === undefined ? {} : { includeUsage: settings.includeUsage }),
    });
  },
  streamText(options) {
    return streamText(options);
  },
};

export function createCompatibleAdapter(options: {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly name: string;
  readonly dependencies?: AiSdkDependencies;
}): ProviderAdapter {
  return createAiSdkAdapter({
    provider: 'compatible',
    providerSettings: {
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      name: options.name,
      includeUsage: true,
    },
    dependencies: options.dependencies ?? productionDependencies,
  });
}
