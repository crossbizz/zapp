export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
const source = {
  set value(_value: number) {
    alias = slots;
  },
};
const copy = Object.assign({}, source);
copy.value = 0;
alias.unshift(require);
slots[0](provider);
