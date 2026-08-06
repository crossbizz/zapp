export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = slots;
function detach() {
  alias = [];
  return alias;
}
detach().unshift(require);
slots[0](provider);
