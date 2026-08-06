export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
function attach() {
  alias = slots;
  return false;
}
(attach() || alias).unshift(require);
slots[0](provider);
