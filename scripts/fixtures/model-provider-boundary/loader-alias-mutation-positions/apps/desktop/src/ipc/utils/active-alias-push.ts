export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
const alias = slots;
alias.push(require);
slots[1](provider);
