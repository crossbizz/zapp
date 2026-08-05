export {};

const provider = '@ai-sdk/openai';
const source = { load: console.info, ...{ load: undefined } };
const { load = require } = source;

load(provider);
