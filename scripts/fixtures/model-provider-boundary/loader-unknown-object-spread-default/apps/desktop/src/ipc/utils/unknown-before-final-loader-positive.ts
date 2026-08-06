export {};

declare const maybe: { load?: NodeRequire };

const provider = '@ai-sdk/openai';
const source = { load: console.info, ...maybe, load: require };

source.load(provider);
