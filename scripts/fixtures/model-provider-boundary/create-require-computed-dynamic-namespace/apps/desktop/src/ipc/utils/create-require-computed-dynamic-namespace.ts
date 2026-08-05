const nodePrefix = 'node:';
const Module = await import(nodePrefix + 'module', { with: {} });

const load = Module.createRequire(import.meta.url);
load('@ai-sdk/openai').createOpenAI({});
