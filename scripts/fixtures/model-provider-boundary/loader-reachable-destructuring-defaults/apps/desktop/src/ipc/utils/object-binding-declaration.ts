export {};

const provider = '@ai-sdk/openai';
const source = {};
const { load = require } = source;

load(provider).createOpenAI({});
