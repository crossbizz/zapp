export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
function configure(value = slots) {
  alias = value;
}
configure();
alias.unshift(require);
slots[0](provider);
