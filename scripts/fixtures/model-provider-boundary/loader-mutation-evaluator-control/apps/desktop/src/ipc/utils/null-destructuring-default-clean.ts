export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
function attach() {
  alias = slots;
  return [];
}
const [value = attach()] = [null];
alias.unshift(require);
slots[0](provider);
void value;
