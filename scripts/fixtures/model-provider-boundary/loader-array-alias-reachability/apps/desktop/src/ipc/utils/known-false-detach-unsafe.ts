export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias = slots;
if (false) alias = [];
alias.unshift(require);
slots[0](provider);
