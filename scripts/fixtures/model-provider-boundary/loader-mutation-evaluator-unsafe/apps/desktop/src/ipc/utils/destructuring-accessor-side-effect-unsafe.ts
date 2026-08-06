export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
const box = {
  get value() {
    alias = slots;
    return 0;
  },
};
const { value } = box;
alias.unshift(require);
slots[0](provider);
void value;
