export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias = [];
const target = {
  get values() {
    alias = slots;
    return [];
  },
};
target['values'].push(0);
alias.unshift(require);
slots[0](provider);
