import { createRequire } from 'node:module';

function identity<T>(value: T): T {
  return value;
}

identity({ factories: [createRequire] })
  .factories[0](import.meta.url)('@ai-sdk/openai')
  .createOpenAI({});
