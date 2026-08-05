import Module from 'node:module';

const load = Module.createRequire(import.meta.url);
load('@ai-sdk/openai').createOpenAI({});
