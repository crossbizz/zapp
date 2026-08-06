import { createRequire } from 'node:module';

function makeFactory() {
  return () => createRequire;
}

makeFactory()()(import.meta.url)('@ai-sdk/openai').createOpenAI({});
