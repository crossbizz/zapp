export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
slots.unshift(require);
slots[0](provider);
