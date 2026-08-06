export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
const copies = [slots].map((value) => value);
copies[0].unshift(require);
slots[0](provider);
