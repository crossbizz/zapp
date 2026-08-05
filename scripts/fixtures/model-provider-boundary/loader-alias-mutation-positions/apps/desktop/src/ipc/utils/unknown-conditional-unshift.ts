export {};

declare const enabled: boolean;

const provider = '@ai-sdk/openai';
const slots = [console.log];
const alias = slots;
if (enabled) alias.unshift(require);
slots[0](provider);
