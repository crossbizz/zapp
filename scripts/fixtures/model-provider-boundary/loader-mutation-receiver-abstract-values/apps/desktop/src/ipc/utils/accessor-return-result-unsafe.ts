export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
const box = {
  get value() {
    return slots;
  },
};
box.value.unshift(require);
slots[0](provider);
