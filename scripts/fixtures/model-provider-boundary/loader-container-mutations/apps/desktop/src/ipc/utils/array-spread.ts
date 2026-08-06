export {};

const loaders = [require];
const spread = [...loaders];

spread[0]('@ai-sdk/openai').createOpenAI({});
