const Module = await import('module');

const load = Module.createRequire(import.meta.url);
load('@ai-sdk/openai').createOpenAI({});
