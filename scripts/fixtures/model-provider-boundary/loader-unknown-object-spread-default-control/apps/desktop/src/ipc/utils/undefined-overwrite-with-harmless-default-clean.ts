export {};

const provider = '@ai-sdk/openai';
const source = { load: require, ...{ load: undefined } };
const { load = console.info } = source;

load(provider);
