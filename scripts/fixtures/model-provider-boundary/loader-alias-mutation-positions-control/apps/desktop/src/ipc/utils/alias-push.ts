export {};

const provider = '@ai-sdk/openai';
const slots: Array<NodeRequire | typeof console.log> = [console.log];
const alias = slots;

alias.push(require);
slots[0](provider);
