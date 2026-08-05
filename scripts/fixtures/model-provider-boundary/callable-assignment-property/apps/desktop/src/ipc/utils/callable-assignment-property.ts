import { createRequire } from 'node:module';

let factory;
factory = createRequire;
const loaders = { node: () => undefined };
loaders.node = factory(import.meta.url);
const load = loaders.node;
load('@ai-sdk/openai').createOpenAI({});
