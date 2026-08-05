import { createRequire } from 'node:module';

createRequire
  .bind(null)(import.meta.url)('@ai-sdk/openai')
  .createOpenAI({});
