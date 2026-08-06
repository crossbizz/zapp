export {};

declare function unknown(): object;

const provider = '@ai-sdk/anthropic';
const slots = [console.info];

Object.assign(slots, { 0: require }, unknown());
slots[0](provider);
