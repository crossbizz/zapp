export {};

const provider = '@ai-sdk/openai';
let loaders: any[];
loaders = [];

loaders.push(require);
loaders[0](provider).createOpenAI({});
