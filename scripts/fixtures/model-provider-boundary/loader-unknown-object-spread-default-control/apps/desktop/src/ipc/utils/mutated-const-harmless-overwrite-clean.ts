export {};

const provider = '@ai-sdk/openai';
const safe = { load: console.log };
safe.load = console.info;
const source = { load: require, ...safe };

source.load(provider);
