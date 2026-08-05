export {};

const provider = '@ai-sdk/openai';
const knownUndefined = { load: undefined };
const source = { load: console.log, ...knownUndefined };
const { load = require } = source;

load(provider);
