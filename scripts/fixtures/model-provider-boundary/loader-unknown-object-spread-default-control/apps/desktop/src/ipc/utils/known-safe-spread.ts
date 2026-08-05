export {};

const provider = '@ai-sdk/openai';
const knownSafe = { load: console.info };
const source = { load: console.log, ...knownSafe };
const { load = require } = source;

load(provider);
