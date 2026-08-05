import { createRequire } from 'node:module';

function consume(factories: { factory: typeof createRequire }) {
  const load = factories.factory(import.meta.url);
  load('@ai-sdk/openai').createOpenAI({});
}

consume({ factory: createRequire });
