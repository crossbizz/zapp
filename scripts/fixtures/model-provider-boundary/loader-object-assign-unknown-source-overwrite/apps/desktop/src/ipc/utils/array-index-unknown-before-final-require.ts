export {};

declare function unknown(): object;

const provider = '@ai-sdk/openai';
const slots = [console.info];

Object.assign(slots, unknown(), { 0: require });
slots[0](provider);
