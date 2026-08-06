export {};

const provider = '@ai-sdk/openai';
const loaders: any[] = [];
const alias = loaders;

alias.push(require);
loaders[0](provider).createOpenAI({});
