export {};

const provider = '@ai-sdk/openai';
const source = { load: undefined };
const { load = require } = source;

load(provider).createOpenAI({});
