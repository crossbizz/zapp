export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
const alias = slots;
do {
  alias.unshift(require);
} while (false);
slots[0](provider);
