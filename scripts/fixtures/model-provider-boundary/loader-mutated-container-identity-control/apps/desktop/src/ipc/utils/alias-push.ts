export {};

const provider = '@ai-sdk/openai';
const loaders: Array<(value: string) => void> = [];
const alias = loaders;

alias.push(console.log);
loaders[0](provider);
