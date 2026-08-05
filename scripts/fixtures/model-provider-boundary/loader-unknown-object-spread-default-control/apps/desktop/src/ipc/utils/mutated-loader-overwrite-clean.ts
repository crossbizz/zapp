export {};

const provider = '@ai-sdk/openai';
const safe = { load: require };
safe.load = console.info;
const source = { load: require, ...safe };

source.load(provider);
