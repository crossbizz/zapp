export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
const box = {
  getDetached() {
    return [];
  },
};
box.getDetached().unshift(require);
slots[0](provider);
