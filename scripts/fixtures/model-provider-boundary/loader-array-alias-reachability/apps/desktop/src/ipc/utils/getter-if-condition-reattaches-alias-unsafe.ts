export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias = slots;
alias = [];
const source = { value: 0 };
if (
  {
    get value() {
      alias = slots;
      return true;
    },
  }.value
) {
}
alias.push(source.value);
alias.unshift(require);
slots[0](provider);
