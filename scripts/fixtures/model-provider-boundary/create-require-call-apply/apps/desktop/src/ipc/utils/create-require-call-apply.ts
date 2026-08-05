import { createRequire } from 'node:module';

createRequire
  .apply(undefined, [import.meta.url])
  .call(undefined, '@ai-sdk/openai')
  .createOpenAI({});
