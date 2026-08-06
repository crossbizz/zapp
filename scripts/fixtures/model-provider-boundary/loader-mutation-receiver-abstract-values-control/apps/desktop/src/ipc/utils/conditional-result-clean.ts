export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = slots;
const condition = Boolean(Date.now());
(condition ? (alias = []) : (alias = [])).unshift(require);
slots[0](provider);
