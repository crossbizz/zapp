export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias = slots;
const copies = [slots].map((value) => {
  alias = [];
  return value;
});
alias.unshift(require);
slots[0](provider);
void copies;
