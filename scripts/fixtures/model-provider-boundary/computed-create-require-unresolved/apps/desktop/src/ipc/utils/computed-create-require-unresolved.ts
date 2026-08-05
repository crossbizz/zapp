import Module from 'node:module';

const key = process.argv[2];
const load = Module[key](import.meta.url);
load('@ai-sdk/openai').createOpenAI({});
