export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
function unreachable() {
  return;
  slots.unshift(require);
}
unreachable();
slots[0](provider);
