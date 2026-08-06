export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias = slots;
alias = [];
const source = { value: 0 };
const trigger = {
  get value() {
    alias = slots;
    return false;
  },
};
let unused: unknown = 0;
unused = trigger.value || 1;
alias.push(source.value);
alias.unshift(require);
slots[0](provider);
