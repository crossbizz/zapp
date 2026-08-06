export {};

declare const maybe: { load?: NodeRequire };

const provider = '@ai-sdk/openai';
const source = { load: require, ...maybe, load: console.info };

source.load(provider);
