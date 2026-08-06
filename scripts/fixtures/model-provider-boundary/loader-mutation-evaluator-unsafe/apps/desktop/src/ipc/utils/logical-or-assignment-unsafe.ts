export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] | null = null;
(alias ||= slots).unshift(require);
slots[0](provider);
