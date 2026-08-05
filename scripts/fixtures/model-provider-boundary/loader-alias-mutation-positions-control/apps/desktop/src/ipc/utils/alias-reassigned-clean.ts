export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias = slots;
alias = [];
alias.push(require);
slots[0](provider);
