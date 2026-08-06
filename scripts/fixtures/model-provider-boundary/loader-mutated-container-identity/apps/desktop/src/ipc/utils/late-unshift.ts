export {};

const provider = '@ai-sdk/openai';
let loaders: any[];
loaders = [];

loaders.unshift(require);
loaders[0](provider).createOpenAI({});
