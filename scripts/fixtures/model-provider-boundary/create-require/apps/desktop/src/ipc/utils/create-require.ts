import { createRequire as nodeCreateRequire } from 'node:module';

const makeRequire = nodeCreateRequire;
const load = makeRequire(import.meta.url);
load('@ai-sdk/openai').createOpenAI({});
