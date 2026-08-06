export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let left = slots;
const right = left;
left = [];
right.unshift(require);
slots[0](provider);
