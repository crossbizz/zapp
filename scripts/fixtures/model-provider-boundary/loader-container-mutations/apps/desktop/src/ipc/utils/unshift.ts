export {};

const loaders: any[] = [];
loaders.unshift(require);

loaders[0]('@ai-sdk/openai').createOpenAI({});
