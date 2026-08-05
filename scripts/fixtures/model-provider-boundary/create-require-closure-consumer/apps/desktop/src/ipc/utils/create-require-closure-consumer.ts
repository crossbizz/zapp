import { createRequire } from 'node:module';

function consume(getFactory: () => typeof createRequire) {
  getFactory()(import.meta.url)('@ai-sdk/openai').createOpenAI({});
}

consume(() => createRequire);
