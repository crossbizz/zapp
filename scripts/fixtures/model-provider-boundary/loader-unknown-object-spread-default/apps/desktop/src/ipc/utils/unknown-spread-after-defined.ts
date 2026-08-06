export {};

declare const maybe: { load?: NodeRequire };

const provider = '@ai-sdk/openai';
const source = { load: console.log, ...maybe };
const { load = require } = source;

load(provider).createOpenAI({});
