export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let left = slots;
const right = left;
left = [];
left.unshift(require);
right[0](provider);
