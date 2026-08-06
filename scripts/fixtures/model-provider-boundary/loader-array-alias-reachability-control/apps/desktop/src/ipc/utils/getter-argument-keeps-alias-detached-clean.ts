export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias = [];
const source = {
  get value() {
    return 0;
  },
};
alias.push(source.value);
alias.unshift(require);
slots[0](provider);
