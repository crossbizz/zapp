export {};

declare function unknown(): object;

const provider = '@ai-sdk/openai';
const slots = [require];

Object.assign(slots, unknown(), { 0: console.info });
slots[0](provider);
