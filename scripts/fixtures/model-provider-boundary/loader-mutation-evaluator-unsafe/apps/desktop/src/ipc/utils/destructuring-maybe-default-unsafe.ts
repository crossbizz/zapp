export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
let maybe: unknown[] | undefined;
function attach() {
  alias = slots;
  return [];
}
const [value = attach()] = [maybe];
alias.unshift(require);
slots[0](provider);
void value;
