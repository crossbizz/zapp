export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = slots;
((alias = []) && (alias = [])).unshift(require);
slots[0](provider);
