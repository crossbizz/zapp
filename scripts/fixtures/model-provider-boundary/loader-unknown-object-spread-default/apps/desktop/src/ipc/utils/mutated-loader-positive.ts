export {};

const provider = '@ai-sdk/openai';
const unsafe = { load: console.info };
unsafe.load = require;
const source = { ...unsafe };

source.load(provider);
