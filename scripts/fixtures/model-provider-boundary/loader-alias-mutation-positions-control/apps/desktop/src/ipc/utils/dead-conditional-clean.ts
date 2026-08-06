export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
const alias = slots;
if (false) alias.unshift(require);
slots[0](provider);
