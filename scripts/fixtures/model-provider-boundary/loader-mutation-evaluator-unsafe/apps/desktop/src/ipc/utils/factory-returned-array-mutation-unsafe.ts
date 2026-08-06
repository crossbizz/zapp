export {};

const provider = '@ai-sdk/openai';
function make(): unknown[] {
  return [console.log];
}
const slots = make();
slots.unshift(require);
slots[0](provider);
