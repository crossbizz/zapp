export {};

declare const maybe: { load?: NodeRequire };

const provider = '@ai-sdk/openai';
const source = { load: require, ...maybe };

source.load(provider);
