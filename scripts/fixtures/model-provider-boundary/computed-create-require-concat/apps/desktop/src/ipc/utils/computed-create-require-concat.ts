import Module from 'node:module';

const key = 'create' + 'Require';
const load = Module[key](import.meta.url);
load('@ai-sdk/openai').createOpenAI({});
