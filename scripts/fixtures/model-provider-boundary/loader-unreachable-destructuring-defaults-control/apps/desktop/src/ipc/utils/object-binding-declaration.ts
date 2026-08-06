export {};

const provider = '@ai-sdk/openai';
const source = { load: console.log };
const { load = require } = source;

load(provider);
