export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
const source = {
  get value() {
    alias = slots;
    return 0;
  },
};
Object.assign({}, source);
alias.unshift(require);
slots[0](provider);
