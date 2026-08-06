import Module = require('node:module');

const load = Module.createRequire(import.meta.url);
load('@ai-sdk/openai').createOpenAI({});
