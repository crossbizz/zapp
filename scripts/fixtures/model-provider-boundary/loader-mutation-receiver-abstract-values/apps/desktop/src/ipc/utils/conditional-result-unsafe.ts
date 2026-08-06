export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
const condition = Boolean(Date.now());
(condition ? (alias = slots) : (alias = slots)).unshift(require);
slots[0](provider);
