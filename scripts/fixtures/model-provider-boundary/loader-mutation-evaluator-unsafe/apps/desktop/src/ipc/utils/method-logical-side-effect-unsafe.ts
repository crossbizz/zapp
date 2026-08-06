export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
const box = {
  attach() {
    alias = slots;
    return true;
  },
};
(box.attach() && alias).unshift(require);
slots[0](provider);
