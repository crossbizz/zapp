export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
function key() {
  alias = slots;
  return 'value';
}
const { [key()]: value } = { value: 0 };
alias.unshift(require);
slots[0](provider);
void value;
