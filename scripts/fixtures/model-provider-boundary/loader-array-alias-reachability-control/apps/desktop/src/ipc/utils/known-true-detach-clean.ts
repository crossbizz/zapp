export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias = slots;
if (true) alias = [];
alias.unshift(require);
slots[0](provider);
