export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias = slots;
function configure(value: unknown[] = []) {
  alias = value;
}
configure();
alias.unshift(require);
slots[0](provider);
