export {};

const provider = '@ai-sdk/openai';
let loaders: Array<(value: string) => void>;
loaders = [];

loaders.push(console.log);
loaders[0](provider);
