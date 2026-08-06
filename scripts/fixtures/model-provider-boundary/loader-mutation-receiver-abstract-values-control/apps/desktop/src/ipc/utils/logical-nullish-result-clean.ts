export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] | null = slots;
((alias = null) ?? (alias = [])).unshift(require);
slots[0](provider);
