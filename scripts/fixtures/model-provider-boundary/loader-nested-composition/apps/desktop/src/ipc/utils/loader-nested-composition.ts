import { createRequire } from 'node:module';

function identity<T>(value: T): T {
  return value;
}

const nested = identity({ factories: [[(0, createRequire).bind(undefined)]] });
identity(nested)
  .factories[0][0](import.meta.url)('@ai-sdk/openai')
  .createOpenAI({});
