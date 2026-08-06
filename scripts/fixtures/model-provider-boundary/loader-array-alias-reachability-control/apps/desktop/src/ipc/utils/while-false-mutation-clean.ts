export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
const alias = slots;
while (false) {
  alias.unshift(require);
}
slots[0](provider);
