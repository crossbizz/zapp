export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
function getSlots() {
  return slots;
}
getSlots().unshift(require);
slots[0](provider);
