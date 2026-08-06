export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
const detached: unknown[] = [];
detached.unshift(require);
slots[0](provider);
