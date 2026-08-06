export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
const box = {
  set value(_value: number) {
    alias = slots;
  },
};
box.value = 1;
alias.unshift(require);
slots[0](provider);
