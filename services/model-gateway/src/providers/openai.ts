import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';

import { createAiSdkAdapter } from './adapter.js';
import type { AiSdkDependencies, ProviderAdapter } from './types.js';

const productionDependencies: AiSdkDependencies = {
  createProvider(settings) {
    return createOpenAI({
      ...(settings.apiKey === undefined ? {} : { apiKey: settings.apiKey }),
      ...(settings.baseURL === undefined ? {} : { baseURL: settings.baseURL }),
    });
  },
  streamText(options) {
    return streamText(options);
  },
};

export function createOpenAIAdapter(options: {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly dependencies?: AiSdkDependencies;
}): ProviderAdapter {
  return createAiSdkAdapter({
    provider: 'openai',
    providerSettings: {
      apiKey: options.apiKey,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    },
    dependencies: options.dependencies ?? productionDependencies,
  });
}
