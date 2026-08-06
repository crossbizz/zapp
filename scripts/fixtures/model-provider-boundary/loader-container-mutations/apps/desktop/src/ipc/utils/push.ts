export {};

const loaders: any[] = [];
loaders.push(require);

loaders[0]('@ai-sdk/openai').createOpenAI({});
