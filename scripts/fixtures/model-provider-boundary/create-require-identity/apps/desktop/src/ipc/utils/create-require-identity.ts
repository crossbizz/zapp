import { createRequire } from 'node:module';

function identity<T>(value: T): T {
  return value;
}

identity(createRequire)(import.meta.url)('@ai-sdk/openai').createOpenAI({});
