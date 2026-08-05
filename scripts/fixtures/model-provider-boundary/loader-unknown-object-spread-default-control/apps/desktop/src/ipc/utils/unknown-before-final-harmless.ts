export {};

declare const maybe: { load?: NodeRequire };

const provider = '@ai-sdk/openai';
const source = { ...maybe, load: console.log };
const { load = require } = source;

load(provider);
