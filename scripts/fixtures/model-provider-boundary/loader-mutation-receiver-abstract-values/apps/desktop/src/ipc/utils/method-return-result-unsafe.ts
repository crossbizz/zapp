export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
const box = {
  getSlots() {
    return slots;
  },
};
box.getSlots().unshift(require);
slots[0](provider);
