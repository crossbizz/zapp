export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
function left() {
  alias = [];
  return { value: 0 };
}
function right() {
  alias = slots;
  return 1;
}
left().value = right();
alias.unshift(require);
slots[0](provider);
