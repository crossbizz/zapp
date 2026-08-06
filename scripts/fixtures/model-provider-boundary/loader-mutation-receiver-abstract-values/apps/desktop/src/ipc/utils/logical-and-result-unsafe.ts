export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
((alias = slots) && (alias = slots)).unshift(require);
slots[0](provider);
