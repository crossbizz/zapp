export {};

const provider = '@ai-sdk/openai';
let loaders: Array<(value: string) => void>;
loaders = [];

loaders.unshift(console.info);
loaders[0](provider);
