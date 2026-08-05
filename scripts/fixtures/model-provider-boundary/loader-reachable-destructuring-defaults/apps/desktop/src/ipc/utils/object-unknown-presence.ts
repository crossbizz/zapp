export {};

const provider = '@ai-sdk/openai';
const source = Math.random() > 0.5 ? { load: console.log } : {};
const { load = require } = source;

load(provider).createOpenAI({});
