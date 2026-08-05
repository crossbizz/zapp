export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias = [];
const source = {
  get value() {
    alias = slots;
    return 0;
  },
};
alias.push({ ...source });
alias.unshift(require);
slots[0](provider);
