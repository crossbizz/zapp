export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
const a = slots;
const b = a;
b.unshift(require);
slots[0](provider);
