export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
const alias = slots;
if (true) alias.unshift(require);
slots[0](provider);
