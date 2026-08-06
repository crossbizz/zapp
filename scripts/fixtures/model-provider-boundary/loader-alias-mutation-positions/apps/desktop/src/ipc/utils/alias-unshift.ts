export {};

const provider = '@ai-sdk/openai';
const slots: Array<NodeRequire | typeof console.log> = [require];
const alias = slots;

alias.unshift(console.log);
slots[1](provider).createOpenAI({});
