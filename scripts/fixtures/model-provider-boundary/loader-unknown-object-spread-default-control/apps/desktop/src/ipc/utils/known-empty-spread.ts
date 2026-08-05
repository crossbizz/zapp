export {};

const provider = '@ai-sdk/openai';
const knownEmpty = {};
const source = { load: console.log, ...knownEmpty };
const { load = require } = source;

load(provider);
