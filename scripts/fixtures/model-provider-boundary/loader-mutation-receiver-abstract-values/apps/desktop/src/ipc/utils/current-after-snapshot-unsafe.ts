export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
const before = { ...slots };
let alias: unknown[] = [];
(alias = slots).unshift(require);
slots[0](provider);
void before;
