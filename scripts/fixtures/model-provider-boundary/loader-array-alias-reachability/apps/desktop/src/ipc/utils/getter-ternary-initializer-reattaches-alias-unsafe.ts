export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias = slots;
alias = [];
const source = { value: 0 };
const trigger = {
  get value() {
    alias = slots;
    return true;
  },
};
const unused = trigger.value ? 1 : 0;
alias.push(source.value);
alias.unshift(require);
slots[0](provider);
