export {};

const provider = '@ai-sdk/openai';
const unsafe = { load: require };
const source = { load: console.info, ...unsafe };

source.load(provider);
