export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
const source = {
  get 1() {
    alias = slots;
    return 1;
  },
  get 0() {
    alias = [];
    return 0;
  },
};
const copy = { ...source };
alias.unshift(require);
slots[0](provider);
void copy;
